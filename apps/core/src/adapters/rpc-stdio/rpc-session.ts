import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { attachSession, InputRefused, type HostConnection } from '../../session-host/client.ts';
import { sessionFile, type ExitRecord } from '../../session-host/protocol.ts';
import { readArtifact, readLines } from '../launcher/session-io.ts';
import type { AdapterEvent, TurnUsage } from '../adapter.types.ts';
import { appendIoRecord } from '../sdk-stream/io-record.ts';
import type { RpcDialect, RpcOut } from './rpc.types.ts';

/**
 * Строка диалекта уходит в stdin с переводом строки: JSON-RPC по stdio разделён строками, без
 * него CLI ждёт продолжения и не отвечает вовсе (проба 02.11 — пустой stdout).
 *
 * Насос сеанса JSON-RPC по stdio: читает stdout.log хоста от смещения, отдаёт строки диалекту,
 * пишет в stdin через хост сессии то, что диалект вернул (рукопожатие, ответы на запросы CLI), и
 * ходы ядра — по одному, когда диалект готов. Тот же порядок такта, что у насоса `stream-json`
 * (`sdk-stream/session.ts`): чтение, запись, проверка выхода. Восстановления после смерти ядра
 * нет — переходник его не объявляет (`reattach` у CLI JSON-RPC не собран).
 */

export interface RpcSessionOptions {
  pollMs?: number;
}

interface QueuedSend {
  cmdId: string;
  uuid: string;
  text: string;
  done: (outcome: { dup: boolean }) => void;
  fail: (error: Error) => void;
}

const reasonText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RpcSession {
  readonly dir: string;
  private readonly dialect: RpcDialect;
  private readonly options: RpcSessionOptions;
  private offset = 0;
  private readonly buffer: AdapterEvent[] = [];
  /** Строки диалекта по порядку: рукопожатие и ответы идут раньше любого хода. */
  private readonly outbox: RpcOut[] = [];
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
  private lastTickError: string | undefined;

  constructor(dir: string, dialect: RpcDialect, options: RpcSessionOptions = {}) {
    this.dir = dir;
    this.dialect = dialect;
    this.options = options;
    this.outbox.push(...dialect.start());
    this.schedule(0);
  }

  get position(): number {
    return this.offset;
  }

  get conversationId(): string | null {
    return this.dialect.conversationId;
  }

  usage(): TurnUsage[] {
    return this.dialect.usage();
  }

  /** Идемпотентна по cmdId: повтор отдаёт исход первой отправки с `dup: true`. */
  send(cmdId: string, text: string): Promise<{ dup: boolean }> {
    const known = this.sends.get(cmdId);
    if (known) return known.then(() => ({ dup: true }));
    if (this.finished) return Promise.reject(new Error('session ended'));
    if (this.closed) return Promise.reject(new Error('session closed'));
    if (this.stopping) return Promise.reject(new Error('session stopping'));
    const failed = this.dialect.failed;
    if (failed) return Promise.reject(new Error(`session handshake failed: ${failed}`));
    const uuid = UUID.test(cmdId) ? cmdId : randomUUID();
    const promise = new Promise<{ dup: boolean }>((done, fail) => {
      this.queue.push({ cmdId, uuid, text, done, fail });
    });
    this.sends.set(cmdId, promise);
    this.schedule(0);
    return promise;
  }

  /** Ответ ядра на вопрос о праве — мимо очереди ходов: CLI стоит посреди хода и ждёт его. */
  async answer(requestId: string, reply: unknown): Promise<void> {
    if (this.finished || this.closed) throw new Error('session ended');
    const out = this.dialect.answer(requestId, reply);
    if (!out) throw new Error(`no permission request ${requestId} in this session`);
    const connection = await this.connect();
    try {
      await connection.send(out.key, `${out.line}\n`);
    } catch (error) {
      if (!(error instanceof InputRefused)) this.connection = null;
      throw error;
    }
    this.record({ t: 'control', id: requestId });
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
    for (const pending of this.queue.splice(0)) pending.fail(new Error('session closed'));
    this.connection?.close();
    this.connection = null;
    this.notify();
  }

  /** Началась остановка: канал хоста забирает команда `stop`, насос лишь дочитывает вывод. */
  async quiesce(): Promise<void> {
    this.stopping = true;
    for (const pending of this.queue.splice(0)) pending.fail(new Error('session stopping'));
    await this.connecting?.catch(() => undefined);
    this.connection?.close();
    this.connection = null;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private schedule(ms: number): void {
    if (this.closed || this.finished) return;
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

  /** Такт упал — сбой назван событием (одна причина — один раз), следующий такт по расписанию. */
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
    this.buffer.push(...events);
    this.notify();
  }

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

  private record(line: Parameters<typeof appendIoRecord>[1]): void {
    try {
      appendIoRecord(this.dir, line);
    } catch {
      /* повтор того же ключа хост отбросит */
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopping) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0 && !this.closed) {
        const next = this.outbox[0] as RpcOut;
        let connection: HostConnection;
        try {
          connection = await this.connect();
        } catch {
          return;
        }
        try {
          await connection.send(next.key, `${next.line}\n`);
          this.outbox.shift();
        } catch (error) {
          // Хост отказал в записи (stdin закрыт): строка не дойдёт никогда — отказ виден.
          if (error instanceof InputRefused) {
            this.outbox.shift();
            this.emit([
              { type: 'error', code: 'protocol', detail: `stdin refused: ${reasonText(error)}` },
            ]);
            continue;
          }
          this.connection = null;
          return;
        }
      }
      const failed = this.dialect.failed;
      if (failed) {
        for (const pending of this.queue.splice(0)) {
          pending.fail(new Error(`session handshake failed: ${failed}`));
        }
        return;
      }
      while (this.queue.length > 0 && this.dialect.ready && !this.closed) {
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
        const out = this.dialect.turn(next.text, next.cmdId, next.uuid);
        try {
          appendIoRecord(this.dir, {
            t: 'send',
            cmdId: next.cmdId,
            uuid: next.uuid,
            at: this.offset,
            data: out.line,
          });
        } catch (error) {
          // Хода нет ни в CLI, ни в записи ввода — диалект отдаёт и его id (вид сеанса без сдвига).
          this.dialect.retract(next.cmdId);
          next.fail(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        try {
          next.done(await connection.send(out.key, `${out.line}\n`));
          this.record({ t: 'ack', cmdId: next.cmdId });
        } catch (error) {
          if (error instanceof InputRefused) this.dialect.forget(next.cmdId);
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
        if (!line.trim()) continue;
        const step = this.dialect.push(line);
        this.emit(step.events);
        this.outbox.push(...step.out);
      }
      for (const bytes of read.oversize ?? []) {
        this.emit([
          {
            type: 'error',
            code: 'protocol',
            detail: `stdout line of ${bytes} bytes over the line cap, skipped`,
          },
        ]);
      }
      this.offset = read.next;
      await this.flush();
      if (read.lines.length === 0 && existsSync(sessionFile(this.dir, 'exit'))) {
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
    const detail = exit
      ? `code ${String(exit.code)}${exit.refused ? `, refused: ${exit.refused}` : ''}${exit.unknown ? `, stop unproven: ${exit.unknown}` : ''}${stderr ? `; ${stderr.slice(-400)}` : ''}`
      : 'exit record unreadable';
    this.emit([{ type: 'error', code: 'exited', detail }]);
    this.finished = true;
    for (const pending of this.queue.splice(0)) pending.fail(new Error('session ended'));
    this.connection?.close();
    this.connection = null;
    this.notify();
  }
}
