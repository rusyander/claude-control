import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * Клиент JSON-RPC по stdio к мосту MCP — так, как с ним говорит CLI: строка на сообщение,
 * ответ по id, уведомления (прогресс) копятся отдельно.
 */

export interface RpcPeer {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notifications: { method: string; params: unknown }[];
}

export function rpcOver(io: { stdin: Writable; stdout: Readable }): RpcPeer {
  let next = 1;
  const waiting = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  const notifications: RpcPeer['notifications'] = [];
  createInterface({ input: io.stdout }).on('line', (line) => {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && waiting.has(msg.id)) {
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    } else if (msg.method) {
      notifications.push({ method: msg.method, params: msg.params });
    }
  });
  return {
    notifications,
    request(method, params = {}, timeoutMs = 15_000) {
      const id = next++;
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`rpc ${method} timed out`)), timeoutMs);
        waiting.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) fail(new Error(JSON.stringify(msg.error)));
          else done(msg.result);
        });
        io.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

/** Текст первого блока ответа `tools/call`, разобранный как JSON. */
export function callText(result: unknown): { isError: boolean; body: unknown } {
  const r = result as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0]?.text ?? '';
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Текст ошибки моста — не JSON.
  }
  return { isError: r.isError === true, body };
}
