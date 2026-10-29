import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import {
  createLivenessProbe,
  type Liveness,
  type LivenessProbe,
} from '../platform/process-identity.ts';
import { reasonOf } from '../platform/os-kind.ts';
import {
  decode,
  encode,
  lineSplitter,
  sessionFile,
  type ExitRecord,
  type HostMessage,
  type HostRecord,
  type HostStopReport,
  type Identity,
  type StreamName,
} from './protocol.ts';

/**
 * Сторона ядра: подключение к хосту сессии по личности (номер + старт), повтор вывода из
 * файлов от смещения журнала, ввод с cmdId (повтор того же cmdId — без второго ввода),
 * остановка. Хост мёртв и исхода нет — `lost` (01: → resume rule); живость не прочитана —
 * `unknown`, а не «мёртв» (F25): решение на `unknown` сессию не хоронит.
 */

export type AttachOutcome =
  | { state: 'live'; session: HostConnection; record: HostRecord }
  | { state: 'exited'; exit: ExitRecord; record: HostRecord | null }
  | {
      state: 'lost';
      reason: string;
      record: HostRecord | null;
      /** CLI мог пережить хост — вызывающий снимает его деревом по этой личности. */
      child: Identity | null;
      childAlive: Liveness;
    }
  | { state: 'unknown'; reason: string };

export interface AttachDeps {
  probe?: LivenessProbe;
  helloTimeoutMs?: number;
}

type Read<T> = { value: T } | { absent: true } | { unknown: string };

function readJson<T>(path: string): Read<T> {
  // «Нет» — только по проверке до чтения (P44): сбой чтения есть unknown, не «хоста нет».
  if (!existsSync(path)) return { absent: true };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/**
 * Полные строки потока начиная со смещения (байты), смещение конца каждой (`ends`) и
 * после последней (`next`).
 * Незаконченная строка остаётся на следующий раз — журнал ядра пишет строку вместе с
 * `next` одной записью, и повтор от `next` не даёт ни пропуска, ни дубля.
 */
export interface LinesRead {
  lines: string[];
  ends: number[];
  next: number;
  /**
   * Строка длиннее `lineMax` пропущена: в `lines` она — пустая строка (её конец в `ends`),
   * здесь — её размер в байтах с `\n`. Читающий называет пропуск, а не теряет хвост молча.
   */
  oversize?: number[];
}

/** Потолок одной строки потока: больше — пропуск с названным размером (core-s2 F-20). */
export const LINE_MAX = 64 * 1024 * 1024;

function readWindow(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const got = readSync(fd, buffer, read, length - read, offset + read);
    if (got === 0) break;
    read += got;
  }
  return buffer.subarray(0, read);
}

/** Конец строки (байт после `\n`) от `from`, кусками, не держа строку в памяти; нет — `-1`. */
function lineEnd(fd: number, from: number, size: number): number {
  const step = 1024 * 1024;
  for (let at = from; at < size; at += step) {
    const chunk = readWindow(fd, at, Math.min(step, size - at));
    const nl = chunk.indexOf(10);
    if (nl >= 0) return at + nl + 1;
  }
  return -1;
}

export function readLines(
  dir: string,
  stream: StreamName,
  offset: number,
  maxBytes = 1024 * 1024,
  lineMax = LINE_MAX,
): LinesRead {
  const file = sessionFile(dir, stream);
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { lines: [], ends: [], next: offset };
  }
  if (size <= offset) return { lines: [], ends: [], next: offset };
  const fd = openSync(file, 'r');
  let buffer: Buffer;
  try {
    // Окно растёт, пока в нём нет ни одного конца строки: строка больше окна иначе стояла бы
    // навсегда, а с выходом CLI терялась бы вместе со всем после неё (core-s2 F-20).
    let length = Math.min(size - offset, maxBytes);
    buffer = readWindow(fd, offset, length);
    while (buffer.indexOf(10) < 0 && length < size - offset && length < lineMax) {
      length = Math.min(size - offset, length * 2, lineMax);
      buffer = readWindow(fd, offset, length);
    }
    if (buffer.indexOf(10) < 0 && length >= lineMax) {
      const end = lineEnd(fd, offset + length, size);
      if (end < 0) return { lines: [], ends: [], next: offset };
      return { lines: [''], ends: [end], next: end, oversize: [end - offset] };
    }
  } finally {
    closeSync(fd);
  }
  const lines: string[] = [];
  const ends: number[] = [];
  let from = 0;
  let at = buffer.indexOf(10, from);
  while (at >= 0) {
    lines.push(buffer.subarray(from, at).toString('utf8').replace(/\r$/, ''));
    ends.push(offset + at + 1);
    from = at + 1;
    at = buffer.indexOf(10, from);
  }
  return { lines, ends, next: ends.at(-1) ?? offset };
}

/** Хост ввод НЕ записал (stdin закрыт, CLI вышел, ошибка записи) — повтор того же не поможет. */
export class InputRefused extends Error {
  readonly cmdId: string;
  constructor(cmdId: string, reason: string) {
    super(`input ${cmdId} refused by host: ${reason}`);
    this.name = 'InputRefused';
    this.cmdId = cmdId;
  }
}

interface PendingAck {
  promise: Promise<{ dup: boolean }>;
  done: (dup: boolean) => void;
  fail: (e: Error) => void;
}

export class HostConnection {
  private readonly socket: Socket;
  private readonly acks = new Map<string, PendingAck>();
  private stopping: Promise<HostStopReport> | undefined;
  private stopWaiter:
    { done: (report: HostStopReport) => void; fail: (e: Error) => void } | undefined;
  private exitListeners: ((exit: ExitRecord) => void)[] = [];
  private closedError: Error | undefined;
  exit: ExitRecord | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    // Канал закрылся — ждущие ответа получают отказ, а не вечное ожидание: ввод без ack
    // ядро повторит тем же cmdId после нового подключения (хост отбросит дубль).
    socket.on('close', () => {
      const closed = new Error('host channel closed');
      this.closedError = closed;
      for (const pending of this.acks.values()) pending.fail(closed);
      this.acks.clear();
      this.stopWaiter?.fail(closed);
      this.stopWaiter = undefined;
    });
  }

  /** Канал уже закрыт: команда не уйдёт, и ответа на неё не будет (core-s2 F-99). */
  private gone(): Error | undefined {
    if (this.closedError) return this.closedError;
    return this.socket.destroyed ? new Error('host channel closed') : undefined;
  }

  /** Сообщение хоста (вызывает подключение; снаружи не нужен). */
  receive(message: HostMessage): void {
    if (message.t === 'ack') {
      this.acks.get(message.cmdId)?.done(message.dup);
      this.acks.delete(message.cmdId);
    } else if (message.t === 'refused') {
      this.acks.get(message.cmdId)?.fail(new InputRefused(message.cmdId, message.reason));
      this.acks.delete(message.cmdId);
    } else if (message.t === 'stopped') {
      // Старый хост поля `unknown` не шлёт — отчёт без него (доказано, как и раньше).
      this.stopWaiter?.done({
        residual: message.residual,
        ...(typeof message.unknown === 'string' ? { unknown: message.unknown } : {}),
      });
      this.stopWaiter = undefined;
    } else if (message.t === 'exit') {
      this.exit = message.exit;
      for (const listener of this.exitListeners) listener(message.exit);
    }
  }

  /**
   * Ввод в stdin CLI; `dup: true` — этот cmdId уже применён, второго ввода не было. Хост ввод
   * не записал — `InputRefused` (core-s2 F-22). Тот же cmdId, пока ответа нет, получает тот же
   * исход, а не второе ожидание, затирающее первое (F-99).
   */
  send(cmdId: string, data: string): Promise<{ dup: boolean }> {
    const pending = this.acks.get(cmdId);
    if (pending) return pending.promise;
    const gone = this.gone();
    if (gone) return Promise.reject(gone);
    let settle: Pick<PendingAck, 'done' | 'fail'> | undefined;
    const promise = new Promise<{ dup: boolean }>((resolve, reject) => {
      settle = { done: (dup) => resolve({ dup }), fail: reject };
    });
    const ack: PendingAck = { promise, ...(settle as Pick<PendingAck, 'done' | 'fail'>) };
    this.acks.set(cmdId, ack);
    this.socket.write(encode({ t: 'input', cmdId, data }), (error) => {
      if (error && this.acks.get(cmdId) === ack) {
        this.acks.delete(cmdId);
        ack.fail(error);
      }
    });
    return promise;
  }

  /** Конец stdin CLI; `false` — канал уже закрыт, команда не ушла. */
  end(): boolean {
    if (this.gone()) return false;
    this.socket.write(encode({ t: 'end' }), () => undefined);
    return true;
  }

  /**
   * Остановка дерева CLI: остаток и сомнение хоста (`unknown` — не доказано). Повторный вызов ждёт
   * ту же остановку, закрытый канал — отказ сразу.
   */
  stop(graceMs?: number): Promise<HostStopReport> {
    if (this.stopping) return this.stopping;
    const gone = this.gone();
    if (gone) return Promise.reject(gone);
    const stopping = new Promise<HostStopReport>((done, fail) => {
      this.stopWaiter = { done, fail };
      this.socket.write(
        encode({ t: 'stop', ...(graceMs === undefined ? {} : { graceMs }) }),
        (error) => {
          if (!error) return;
          this.stopWaiter = undefined;
          fail(error);
        },
      );
    });
    this.stopping = stopping;
    const settled = (): void => {
      if (this.stopping === stopping) this.stopping = undefined;
    };
    stopping.then(settled, settled);
    return stopping;
  }

  onExit(listener: (exit: ExitRecord) => void): void {
    if (this.exit) listener(this.exit);
    else this.exitListeners.push(listener);
  }

  close(): void {
    this.socket.destroy();
  }
}

function open(
  record: HostRecord,
  token: string,
  timeoutMs: number,
): Promise<{ connection: HostConnection } | { error: string }> {
  return new Promise((done) => {
    const socket = connect(record.channel);
    const connection = new HostConnection(socket);
    let welcomed = false;
    const timer = setTimeout(() => {
      socket.destroy();
      done({ error: 'no welcome from host' });
    }, timeoutMs);
    socket.on('error', (error) => {
      clearTimeout(timer);
      if (!welcomed) done({ error: reasonOf(error) });
    });
    // Хост отказал (чужой ключ, CLI ещё не запущен) и закрыл канал — ответ сразу, а не по
    // сроку приветствия (core-s2 F-99).
    socket.once('close', () => {
      clearTimeout(timer);
      if (!welcomed) done({ error: 'host closed the channel before welcome' });
    });
    socket.on(
      'data',
      lineSplitter((line) => {
        const message = decode<HostMessage>(line);
        if (!message) return;
        if (!welcomed && message.t === 'welcome') {
          welcomed = true;
          clearTimeout(timer);
          if (message.exited) connection.receive({ t: 'exit', exit: message.exited });
          done({ connection });
          return;
        }
        connection.receive(message);
      }),
    );
    socket.write(encode({ t: 'hello', token }));
  });
}

export async function attachSession(dir: string, deps: AttachDeps = {}): Promise<AttachOutcome> {
  const probe = deps.probe ?? createLivenessProbe(undefined, 0);
  const exitRead = readJson<ExitRecord>(sessionFile(dir, 'exit'));
  const hostRead = readJson<HostRecord>(sessionFile(dir, 'host'));
  const record = 'value' in hostRead ? hostRead.value : null;
  if ('value' in exitRead) return { state: 'exited', exit: exitRead.value, record };
  // Исход есть, но не читается: «хоста нет, исхода нет» сказать нельзя (P44, core-s2 F-43).
  if ('unknown' in exitRead) return { state: 'unknown', reason: `exit.json: ${exitRead.unknown}` };
  if ('unknown' in hostRead) return { state: 'unknown', reason: `host.json: ${hostRead.unknown}` };
  if (!record) {
    return {
      state: 'lost',
      reason: 'no host record',
      record: null,
      child: null,
      childAlive: 'dead',
    };
  }
  const hostAlive = await probe.isAlive(record.host);
  if (hostAlive === 'unknown') return { state: 'unknown', reason: 'host liveness unknown' };
  if (hostAlive === 'dead') {
    // Хост мог записать исход и уйти между двумя чтениями.
    const late = readJson<ExitRecord>(sessionFile(dir, 'exit'));
    if ('value' in late) return { state: 'exited', exit: late.value, record };
    if ('unknown' in late) return { state: 'unknown', reason: `exit.json: ${late.unknown}` };
    const childAlive = record.child ? await probe.isAlive(record.child) : 'dead';
    return {
      state: 'lost',
      reason: 'host dead, no exit record',
      record,
      child: record.child,
      childAlive,
    };
  }
  let token: string;
  try {
    token = readFileSync(sessionFile(dir, 'token'), 'utf8').trim();
  } catch (error) {
    return { state: 'unknown', reason: `token: ${reasonOf(error)}` };
  }
  const opened = await open(record, token, deps.helloTimeoutMs ?? 5_000);
  if ('error' in opened) {
    // Уходящий хост пишет исход и закрывает канал, пока его pid ещё жив.
    const finished = readJson<ExitRecord>(sessionFile(dir, 'exit'));
    if ('value' in finished) return { state: 'exited', exit: finished.value, record };
    return { state: 'unknown', reason: `channel: ${opened.error}` };
  }
  return { state: 'live', session: opened.connection, record };
}
