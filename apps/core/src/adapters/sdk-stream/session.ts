import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { attachSession, InputRefused, type HostConnection } from '../../session-host/client.ts';
import { sessionFile, type ExitRecord } from '../../session-host/protocol.ts';
import { readArtifact, readLines } from '../launcher/session-io.ts';
import type { AdapterErrorCode, AdapterEvent, TurnUsage } from '../adapter.types.ts';
import { SdkNormaliser, type SdkRule } from './normalise.ts';
import { appendIoRecord, readIoRecord } from './io-record.ts';
import { SDK_PERMIT_CODEC } from './permit-codec.ts';

/**
 * Насос сессии `stream-json`, которым владеет хэндл: читает stdout.log хоста от смещения
 * (повтор после переподключения точен до байта), кормит разборщик и отдаёт события одному
 * потребителю; отправки ставит в очередь и выпускает по правилу переходника — за ходом,
 * начатым CLI, не шлёт никогда, без эха — только в простое и по одной (03).
 */

export interface SdkSessionOptions {
  pollMs?: number;
  /** Смещение stdout.log, с которого читать (после перезапуска ядра). */
  fromOffset?: number;
  /**
   * Кто отвечает на вопрос о праве строкой протокола (`can_use_tool`): `core` — событие
   * `permit.request` и ответ `answerControl`; `refuse` (по умолчанию) — отказ сразу, без
   * ожидания срока CLI (fail-closed).
   */
  permit?: 'core' | 'refuse';
  /**
   * Тело управляющего `initialize`, которое уходит ПЕРВОЙ строкой stdin: без него CLI с
   * вопросом о праве строкой протокола работает в «прямом» режиме и на вопросе висит молча.
   */
  initialize?: Record<string, unknown>;
  /**
   * Насос прежнего ядра восстанавливается (01 §Sessions at core death, P89): stdout.log
   * разбирается с начала с ожиданиями ходов из `core-io.jsonl` на прежних местах, события
   * истории идут первыми (`replayed` — сколько), отвеченные управляющие запросы не задаются
   * снова, неподтверждённые отправки уходят тем же cmdId.
   */
  resume?: boolean;
}

/** Id управляющего `initialize` сеанса: хост не пишет повтор той же команды (перезапуск ядра). */
const INITIALIZE_ID = 'initialize';

/** Подтип управляющего запроса «можно ли инструмент» — общий для CLI формата SDK. */
const CAN_USE_TOOL = 'can_use_tool';

/** Ответ на управляющий запрос формата SDK: конверт общий, тело — решение. */
export function sdkControlResponse(requestId: string, reply: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: reply },
  })}\n`;
}

export function sdkControlError(requestId: string, error: string): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  })}\n`;
}

interface QueuedSend {
  cmdId: string;
  uuid: string;
  data: string;
  done: (outcome: { dup: boolean }) => void;
  fail: (error: Error) => void;
}

const reasonText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Сообщение пользователя формата SDK — одинаково у обоих CLI на `--input-format stream-json`. */
export function sdkUserLine(text: string, uuid: string): string {
  return `${JSON.stringify({
    type: 'user',
    uuid,
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

export class SdkSession {
  readonly dir: string;
  private readonly normaliser: SdkNormaliser;
  private readonly rule: SdkRule;
  private readonly options: SdkSessionOptions;
  private offset: number;
  private readonly buffer: AdapterEvent[] = [];
  private readonly queue: QueuedSend[] = [];
  private readonly sends = new Map<string, Promise<{ dup: boolean }>>();
  private connection: HostConnection | null = null;
  private connecting: Promise<HostConnection> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  private closed = false;
  private flushing = false;
  private ticking = false;
  private rerun = false;
  private initPending: boolean;
  private readonly errorCodes = new Set<AdapterErrorCode>();
  /** Управляющие запросы, ответ на которые хост подтвердил (этим ядром или прежним). */
  private readonly answered = new Set<string>();
  /** Отправки прежнего ядра без подтверждения хоста: уходят первыми, тем же cmdId. */
  private readonly resend: QueuedSend[] = [];
  private replayedCount = 0;
  private lastTickError: string | undefined;

  constructor(dir: string, rule: SdkRule, options: SdkSessionOptions = {}) {
    this.dir = dir;
    this.rule = rule;
    this.normaliser = new SdkNormaliser(rule);
    this.options = options;
    this.offset = options.fromOffset ?? 0;
    if (options.resume) this.restore();
    this.initPending = options.initialize !== undefined && !this.answered.has(INITIALIZE_ID);
    this.schedule(0);
  }

  get position(): number {
    return this.offset;
  }

  /** Сколько первых событий потока — история, восстановленная из stdout.log (`resume`). */
  get replayed(): number {
    return this.replayedCount;
  }

  /** Канал хоста, уже открытый тем, кто прикреплял сеанс: второе подключение сбросило бы его. */
  adopt(connection: HostConnection): void {
    if (this.connection || this.closed || this.finished) connection.close();
    else this.connection = connection;
  }

  private restore(): void {
    const record = readIoRecord(this.dir);
    for (const id of record.controls) this.answered.add(id);
    const sends = [...record.sends].sort((a, b) => a.at - b.at);
    let next = 0;
    const expectUpTo = (offset: number): void => {
      for (; next < sends.length && sends[next]!.at <= offset; next += 1) {
        this.normaliser.expect(sends[next]!.cmdId, sends[next]!.uuid);
      }
    };
    let offset = 0;
    for (;;) {
      const read = readLines(this.dir, 'stdout', offset);
      if (read.lines.length === 0) break;
      read.lines.forEach((line, i) => {
        // Ожидание встаёт ровно туда, где прежний насос его поставил: перед строкой с его места.
        expectUpTo(i === 0 ? offset : read.ends[i - 1]!);
        if (line.trim()) this.emit(this.normaliser.push(line));
      });
      this.emitOversize(read.oversize);
      offset = read.next;
    }
    expectUpTo(Number.POSITIVE_INFINITY);
    this.offset = offset;
    this.replayedCount = this.buffer.length;
    for (const send of record.sends) {
      if (send.acked) {
        this.sends.set(send.cmdId, Promise.resolve({ dup: false }));
        continue;
      }
      const promise = new Promise<{ dup: boolean }>((done, fail) => {
        this.resend.push({ cmdId: send.cmdId, uuid: send.uuid, data: send.data, done, fail });
      });
      // Отказ повтора виден тому, кто спросит этот cmdId; иначе он не должен ронять процесс.
      promise.catch(() => undefined);
      this.sends.set(send.cmdId, promise);
    }
  }

  get conversationId(): string | null {
    return this.normaliser.conversationId;
  }

  usage(): TurnUsage[] {
    return this.normaliser.usage();
  }

  /** Идемпотентна по cmdId: повтор отдаёт исход первой отправки с `dup: true`. */
  send(cmdId: string, text: string): Promise<{ dup: boolean }> {
    const known = this.sends.get(cmdId);
    if (known) return known.then(() => ({ dup: true }));
    if (this.finished) return Promise.reject(new Error('session ended'));
    // Закрытый насос больше не тактует: отправка в очереди не ушла бы и не отказала никогда.
    if (this.closed) return Promise.reject(new Error('session closed'));
    if (this.stopping) return Promise.reject(new Error('session stopping'));
    const uuid = UUID.test(cmdId) ? cmdId : randomUUID();
    const promise = new Promise<{ dup: boolean }>((done, fail) => {
      this.queue.push({ cmdId, uuid, data: sdkUserLine(text, uuid), done, fail });
    });
    this.sends.set(cmdId, promise);
    this.schedule(0);
    return promise;
  }

  async *events(): AsyncGenerator<AdapterEvent> {
    for (;;) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.finished || this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const pending of this.drainQueued()) pending.fail(new Error('session closed'));
    this.connection?.close();
    this.connection = null;
    this.notify();
  }

  private drainQueued(): QueuedSend[] {
    return [...this.resend.splice(0), ...this.queue.splice(0)];
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private schedule(ms: number): void {
    if (this.closed || this.finished) return;
    // Идущий такт перечитает сам: два такта разом прочли бы одно смещение дважды.
    if (this.ticking) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.tick().catch((error: unknown) => this.tickFailed(error)),
      ms,
    );
  }

  /**
   * Такт упал (чтение вывода, разборщик, сопоставление): необработанный отказ уронил бы ядро, а
   * насос встал бы навсегда (core-s2 F-42). Сбой называется событием (одна причина — один раз),
   * следующий такт идёт по расписанию.
   */
  private tickFailed(error: unknown): void {
    this.ticking = false;
    const reason = reasonText(error);
    if (reason !== this.lastTickError) {
      this.lastTickError = reason;
      this.emit([{ type: 'error', code: 'protocol', detail: `session pump: ${reason}` }]);
    }
    this.schedule(this.options.pollMs ?? 50);
  }

  private emit(events: AdapterEvent[]): void {
    if (events.length === 0) return;
    for (const event of events) if (event.type === 'error') this.errorCodes.add(event.code);
    this.buffer.push(...events);
    this.notify();
  }

  /** Строка вывода сверх потолка пропущена читателем — это названная ошибка потока, не тишина. */
  private emitOversize(sizes: number[] | undefined): void {
    for (const bytes of sizes ?? []) {
      this.emit([
        {
          type: 'error',
          code: 'protocol',
          detail: `stdout line of ${bytes} bytes over the line cap, skipped`,
        },
      ]);
    }
  }

  private canSend(): boolean {
    if (this.normaliser.cliBusy) return false;
    // Без эха ход не узнать иначе как следующим: по одной и только в простое.
    if (!this.rule.echo) return !this.normaliser.busy && this.normaliser.waiting === 0;
    return true;
  }

  /**
   * Подключение к хосту — одно на сеанс: хост держит одного клиента и новое подключение
   * сбрасывает прежнее, поэтому два параллельных подключения насоса отняли бы канал друг у друга.
   */
  private connect(): Promise<HostConnection> {
    if (this.stopping) return Promise.reject(new Error('session stopping'));
    if (this.connection) return Promise.resolve(this.connection);
    this.connecting ??= (async () => {
      const attached = await attachSession(this.dir);
      if (attached.state !== 'live') throw new Error(`session not live: ${attached.state}`);
      this.connection = attached.session;
      return attached.session;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Началась остановка: канал хоста забирает команда `stop`. Насос больше не подключается —
   * иначе он сбросил бы её подключение посреди остановки, — но дочитывает вывод до выхода CLI.
   * Отправки в очереди отказываются; ответ о праве после этого не уходит.
   */
  async quiesce(): Promise<void> {
    this.stopping = true;
    for (const pending of this.drainQueued()) pending.fail(new Error('session stopping'));
    await this.connecting?.catch(() => undefined);
    this.connection?.close();
    this.connection = null;
  }

  /**
   * Ответ на управляющий запрос CLI — мимо очереди отправок: CLI стоит посреди хода и ждёт
   * именно его. Идемпотентен по id запроса (хост повтор той же команды не пишет).
   */
  async answerControl(requestId: string, reply: unknown): Promise<void> {
    await this.writeControl(requestId, sdkControlResponse(requestId, reply));
  }

  private async writeControl(requestId: string, data: string): Promise<void> {
    if (this.finished || this.closed) throw new Error('session ended');
    const connection = await this.connect();
    try {
      await connection.send(`control:${requestId}`, data);
    } catch (error) {
      // Отказ хоста в записи — канал жив, ввод просто не записан (core-s2 F-22).
      if (!(error instanceof InputRefused)) this.connection = null;
      throw error;
    }
    this.answered.add(requestId);
    this.record({ t: 'control', id: requestId });
  }

  /** Запись ввода после ack: потеря значит лишь повтор, который хост отбросит как дубль. */
  private record(line: Parameters<typeof appendIoRecord>[1]): void {
    try {
      appendIoRecord(this.dir, line);
    } catch {
      /* повтор того же cmdId безопасен */
    }
  }

  private handleControl(): void {
    for (const control of this.normaliser.takeControl()) {
      // История после перезапуска ядра: на этот запрос прежнее ядро уже ответило.
      if (this.answered.has(control.requestId)) continue;
      if (control.subtype !== CAN_USE_TOOL) {
        // Запросы, которых ядро не объявляло (хуки SDK, его MCP), — отказ, не молчание до срока.
        void this.writeControl(
          control.requestId,
          sdkControlError(control.requestId, `unsupported: ${control.subtype}`),
        ).catch(() => undefined);
        continue;
      }
      if (this.options.permit === 'core') {
        this.emit([{ type: 'permit.request', requestId: control.requestId, raw: control.request }]);
        continue;
      }
      const input = control.request.input;
      try {
        const ask = this.rule.mapPermission({
          tool: typeof control.request.tool_name === 'string' ? control.request.tool_name : '',
          input:
            typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
        });
        this.emit([{ type: 'ask', ask, denied: true }]);
      } catch (error) {
        // Сопоставление упало — вопрос всё равно получает отказ, а сбой назван (core-s2 F-42).
        this.emit([
          {
            type: 'error',
            code: 'protocol',
            detail: `permission mapping failed: ${reasonText(error)}`,
          },
        ]);
      }
      void this.answerControl(
        control.requestId,
        SDK_PERMIT_CODEC.render({
          allow: false,
          message: 'No permission answerer in this session.',
        }),
      ).catch(() => undefined);
    }
  }

  private async flushSends(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (this.initPending && this.options.initialize) {
        // Не вышло — повтор следующим тактом; сообщения ждут: до него CLI их не так поймёт.
        await this.writeControl(
          INITIALIZE_ID,
          `${JSON.stringify({
            type: 'control_request',
            request_id: INITIALIZE_ID,
            request: this.options.initialize,
          })}\n`,
        ).then(
          () => {
            this.initPending = false;
          },
          () => undefined,
        );
        if (this.initPending) return;
      }
      // Отправки прежнего ядра: их ожидание хода уже стоит на прежнем месте, правило очереди
      // их не держит — хост либо пишет впервые, либо отвечает дублем.
      while (this.resend.length > 0 && !this.closed) {
        const next = this.resend[0] as QueuedSend;
        let connection: HostConnection;
        try {
          connection = await this.connect();
        } catch {
          return;
        }
        try {
          const outcome = await connection.send(next.cmdId, next.data);
          this.resend.shift();
          this.record({ t: 'ack', cmdId: next.cmdId });
          next.done(outcome);
        } catch (error) {
          // Хост отказал в записи (stdin закрыт, CLI вышел): повтор не поможет — отказ виден.
          if (error instanceof InputRefused) {
            this.resend.shift();
            next.fail(error);
            continue;
          }
          this.connection = null;
          return;
        }
      }
      while (this.queue.length > 0 && this.canSend() && !this.closed) {
        const next = this.queue[0] as QueuedSend;
        let connection: HostConnection;
        try {
          connection = await this.connect();
        } catch (error) {
          this.queue.shift();
          next.fail(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        this.queue.shift();
        try {
          // До записи в хост: дошедшая отправка всегда записана, с местом её ожидания хода.
          appendIoRecord(this.dir, {
            t: 'send',
            cmdId: next.cmdId,
            uuid: next.uuid,
            at: this.offset,
            data: next.data,
          });
        } catch (error) {
          next.fail(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        // Ждём эха до записи: строка эха может прийти раньше, чем ack хоста.
        this.normaliser.expect(next.cmdId, next.uuid);
        try {
          next.done(await connection.send(next.cmdId, next.data));
          this.record({ t: 'ack', cmdId: next.cmdId });
        } catch (error) {
          // Отказ хоста: отправка не дошла до CLI, её ожидание хода снимается — иначе без эха
          // `waiting` не опустеет и насос не отправит больше ничего (F-38).
          if (error instanceof InputRefused) this.normaliser.forget(next.cmdId);
          else this.connection = null;
          next.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.closed || this.finished) return;
    this.ticking = true;
    this.rerun = false;
    let ended = false;
    try {
      const read = readLines(this.dir, 'stdout', this.offset);
      for (const line of read.lines) {
        if (line.trim()) this.emit(this.normaliser.push(line));
      }
      this.emitOversize(read.oversize);
      this.offset = read.next;
      this.handleControl();
      await this.flushSends();
      if (read.lines.length === 0 && existsSync(sessionFile(this.dir, 'exit'))) {
        // Хост пишет exit.json после последнего байта вывода: перечитываем, потом кончаем.
        ended = readLines(this.dir, 'stdout', this.offset).lines.length === 0;
      }
    } finally {
      this.ticking = false;
    }
    if (ended) this.finish();
    else this.schedule(this.rerun ? 0 : (this.options.pollMs ?? 50));
  }

  private finish(): void {
    let exit: ExitRecord | null;
    try {
      exit = JSON.parse(readFileSync(sessionFile(this.dir, 'exit'), 'utf8')) as ExitRecord;
    } catch {
      exit = null;
    }
    const stderr = readArtifact(this.dir, 'stderr').text;
    // Тот же отказ уже пришёл строкой потока — выход называется просто выходом.
    const classified = this.rule.classifyError?.(stderr) ?? null;
    const code: AdapterErrorCode =
      classified && !this.errorCodes.has(classified) ? classified : 'exited';
    const detail = exit
      ? `code ${String(exit.code)}${exit.refused ? `, refused: ${exit.refused}` : ''}${exit.unknown ? `, stop unproven: ${exit.unknown}` : ''}${stderr ? `; ${stderr.slice(-400)}` : ''}`
      : 'exit record unreadable';
    this.emit([{ type: 'error', code, detail }]);
    this.finished = true;
    for (const pending of this.drainQueued()) pending.fail(new Error('session ended'));
    this.connection?.close();
    this.connection = null;
    this.notify();
  }
}
