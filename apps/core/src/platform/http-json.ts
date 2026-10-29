import { request } from 'node:http';

/**
 * JSON по HTTP к ядру на loopback (мосты MCP сессии, 03 §Model tools). Сетевой вызов — дело
 * платформы (P44): мост знает только исход. Ядро перезапускается, а сессия живёт (01 §Sessions
 * at core death), поэтому «не достучались» — отдельный исход, его повторяет вызывающий; ответ
 * ядра с любым кодом — уже ответ, его не повторяют.
 */

export type HttpJsonOutcome =
  | { kind: 'reply'; status: number; body: unknown }
  /** `refused` — соединение не открылось: запрос не дошёл, повтор безопасен. */
  | { kind: 'unreachable'; reason: string; refused: boolean };

export interface HttpJsonCall {
  url: string;
  method: 'GET' | 'POST';
  bearer: string;
  body?: unknown;
  timeoutMs: number;
}

/** Предел ответа: ядро не шлёт мосту больше, а чужой процесс на порте не раздует память. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

export function httpJson(call: HttpJsonCall): Promise<HttpJsonOutcome> {
  return new Promise((done) => {
    let settled = false;
    const finish = (outcome: HttpJsonOutcome): void => {
      if (settled) return;
      settled = true;
      done(outcome);
    };
    const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
    const req = request(
      call.url,
      {
        method: call.method,
        headers: {
          authorization: `Bearer ${call.bearer}`,
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }),
        },
        timeout: call.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REPLY_BYTES) {
            req.destroy(new Error('reply too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // Не JSON — отдаём текстом: вызывающий сам решит, что это не ответ ядра.
          }
          finish({ kind: 'reply', status: res.statusCode ?? 0, body });
        });
        res.on('error', (error) =>
          finish({ kind: 'unreachable', reason: error.message, refused: false }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout ${call.timeoutMs} ms`)));
    req.on('error', (error: NodeJS.ErrnoException) =>
      finish({
        kind: 'unreachable',
        reason: error.message,
        refused: error.code === 'ECONNREFUSED',
      }),
    );
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
