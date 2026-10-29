import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/**
 * Сервер MCP по stdio (JSON-RPC строками) — общий для мостов `agentdeck` и
 * `agentdeck-permit`. Мост ничего не решает: список и вызов уходят в ядро, сюда возвращается
 * только ответ. Пока вызов ждёт ядро, мост шлёт `notifications/progress` по токену вызова:
 * CLI рвёт вызов MCP без ответа и без прогресса по своему сроку бездействия (проверено живьём
 * на сервере права панели — `permission-prompt-server.mjs`), а общий для всех серверов срок
 * менять нельзя.
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpHandlers {
  list(): Promise<McpToolDef[] | { error: string }>;
  call(name: string, args: unknown): Promise<McpToolResult>;
}

export interface StdioServerOptions {
  name: string;
  version: string;
  handlers: McpHandlers;
  input: Readable;
  write(line: string): void;
  /** Шаг прогресса, мс; 0 — без прогресса. */
  progressMs: number;
  /**
   * stdin закрыт (CLI ушёл) — сколько ещё ждать начатые вызовы, мс. Ответ читать уже некому:
   * мост не живёт минутами ради повтора к ядру (core-s2 F-91).
   */
  closeGraceMs?: number;
}

/**
 * Версии протокола, которые сервер знает (только инструменты — их форма во всех одна). Клиент
 * просит знакомую — она и отвечается; незнакомую — последняя знакомая, а не эхо любой строки
 * (core-s2 F-85): решать, работать ли с ней, — клиенту.
 */
const LATEST_PROTOCOL = '2025-11-25';
export const PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  LATEST_PROTOCOL,
] as const;

type RpcId = string | number;

function negotiate(asked: unknown): string {
  return typeof asked === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
    ? asked
    : LATEST_PROTOCOL;
}

function isToolList(value: unknown): value is McpToolDef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (tool) =>
        tool !== null &&
        typeof tool === 'object' &&
        typeof (tool as { name?: unknown }).name === 'string',
    )
  );
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function serveStdio(opts: StdioServerOptions): Promise<void> {
  const send = (message: Record<string, unknown>): void =>
    opts.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  /** Вызовы в работе: отменённый клиентом ответа не получает и пульс не шлёт. */
  const live = new Map<RpcId, { stop: () => void }>();
  const result = (id: RpcId, value: unknown): void => {
    if (!live.has(id)) return;
    live.get(id)?.stop();
    live.delete(id);
    send({ id, result: value });
  };
  const error = (id: RpcId, code: number, message: string): void => {
    if (!live.has(id)) return;
    live.get(id)?.stop();
    live.delete(id);
    send({ id, error: { code, message } });
  };

  const heartbeat = (token: unknown): (() => void) => {
    if ((typeof token !== 'string' && typeof token !== 'number') || opts.progressMs <= 0) {
      return () => undefined;
    }
    let beats = 0;
    const timer = setInterval(() => {
      beats += 1;
      send({
        method: 'notifications/progress',
        params: { progressToken: token, progress: beats, message: 'Waiting for the core' },
      });
    }, opts.progressMs);
    return () => clearInterval(timer);
  };

  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  const notification = (method: string, params: Record<string, unknown> | undefined): void => {
    // Клиент отменил вызов: пульс стоп, ответа нет (MCP §cancellation). Ядро вызов уже несёт —
    // отозвать его мост не может, но и ответ, которого не ждут, не шлёт.
    if (method !== 'notifications/cancelled') return;
    const id = params?.requestId;
    if ((typeof id === 'string' || typeof id === 'number') && live.has(id)) {
      live.get(id)?.stop();
      live.delete(id);
    }
  };

  const handle = (msg: { id?: RpcId; method?: unknown; params?: Record<string, unknown> }) => {
    const { id, method, params } = msg;
    if (typeof method !== 'string') return;
    // Уведомление (без id) ответа не требует — ни своё, ни незнакомое.
    if (id === undefined || id === null) {
      notification(method, params);
      return;
    }
    live.set(id, { stop: () => undefined });
    switch (method) {
      case 'initialize': {
        result(id, {
          protocolVersion: negotiate(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: opts.name, version: opts.version },
        });
        return;
      }
      case 'ping':
        result(id, {});
        return;
      case 'tools/list':
        // Ответ ядра не той формы (нет `tools`) — ошибка JSON-RPC, а не падение моста (core-s2 F-74).
        track(
          opts.handlers
            .list()
            .then((tools) => {
              if (isToolList(tools)) result(id, { tools });
              else if (tools && typeof tools === 'object' && 'error' in tools)
                error(id, -32603, String(tools.error));
              else error(id, -32603, 'core answered without a tool list');
            })
            .catch((e: unknown) => error(id, -32603, messageOf(e))),
        );
        return;
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : '';
        const meta = params?._meta as { progressToken?: unknown } | undefined;
        live.set(id, { stop: heartbeat(meta?.progressToken) });
        // Сбой вне предусмотренного — тоже ответ: иначе пульс шёл бы вечно, а CLI ждал бы.
        track(
          opts.handlers
            .call(name, params?.arguments ?? {})
            .catch((e: unknown) => ({ text: `bridge failure: ${messageOf(e)}`, isError: true }))
            .then((r) => {
              result(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
            }),
        );
        return;
      }
      default:
        error(id, -32601, 'Method not found');
    }
  };

  const lines = createInterface({ input: opts.input });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) handle(msg as never);
  });
  return new Promise((done) => {
    lines.on('close', () => {
      const grace = new Promise<void>((resolve) => {
        setTimeout(resolve, opts.closeGraceMs ?? 1_000).unref();
      });
      void Promise.race([Promise.allSettled([...pending]), grace]).then(() => {
        for (const call of live.values()) call.stop();
        live.clear();
        done();
      });
    });
  });
}
