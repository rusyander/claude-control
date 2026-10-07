import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * JSON-RPC строками по stdio — общий у серверных режимов CLI, говорящих так
 * (`codex app-server`, ACP у `goose acp`). Здесь только транспорт: кто что
 * вызывает и что значат уведомления, решает ход конкретного CLI.
 */

export interface RpcReply {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

export interface RpcIncoming {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export class StdioRpc {
  private nextId = 1;
  private readonly pending = new Map<number, (reply: RpcReply) => void>();
  private readonly child: ChildProcessWithoutNullStreams;
  /** Codex говорит «JSON-RPC без версии» и поле `jsonrpc` не шлёт; ACP — шлёт. */
  private readonly version: Record<string, string>;

  /**
   * `onNotification` — сообщение без `id`; `onRequest` — вопрос сервера к
   * клиенту (разрешение, файл): ответ на него обязан уйти, иначе ход встанет.
   */
  constructor(
    child: ChildProcessWithoutNullStreams,
    handlers: {
      onNotification: (message: RpcIncoming) => void;
      onRequest: (message: RpcIncoming & { readonly id: number | string }) => void;
    },
    options: { jsonrpcField?: boolean } = {},
  ) {
    this.child = child;
    this.version = options.jsonrpcField === false ? {} : { jsonrpc: '2.0' };
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: RpcIncoming & RpcReply;
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        const id = Number(message.id);
        this.pending.get(id)?.(message);
        this.pending.delete(id);
        return;
      }
      if (message.id !== undefined) handlers.onRequest({ ...message, id: message.id });
      else if (message.method) handlers.onNotification(message);
    });
  }

  /** Вызов с ответом; `undefined` — сервер не ответил за `timeoutMs` или ушёл. */
  call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<RpcReply | undefined> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.write({ ...this.version, id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ ...this.version, method, ...(params ? { params } : {}) });
  }

  respond(id: number | string, outcome: { result: unknown } | { error: RpcReply['error'] }): void {
    this.write({ ...this.version, id, ...outcome });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Процесс уже ушёл — ход закончится событием close.
    }
  }
}
