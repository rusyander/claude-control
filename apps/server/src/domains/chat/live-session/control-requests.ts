/**
 * Управляющие запросы живой сессии CLI — `control_request` в его stdin в
 * формате stream-json и `control_response` в ответ (claude 2.1.3xx; тем же
 * путём расширение VS Code останавливает субагента: `stop_task`).
 *
 * Ответ ищется по `request_id` и до прогона не доходит: это разговор панели с
 * процессом, а не событие хода.
 */

/** Итог управляющего запроса. */
export type ControlReply =
  | { outcome: 'ok' }
  | { outcome: 'error'; message: string }
  /** Процесс закрылся или ответа не дождались. */
  | { outcome: 'unconfirmed' };

/** Сколько ждать ответа CLI: он отвечает сразу, между шагами модели. */
const REPLY_TIMEOUT_MS = 5000;

interface Pending {
  resolve: (reply: ControlReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ControlRequests {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs = REPLY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** Отправить запрос; `write` — строка в stdin процесса. */
  send(write: (line: string) => void, request: Record<string, unknown>): Promise<ControlReply> {
    this.counter += 1;
    const requestId = `agentdeck-${Date.now().toString(36)}-${this.counter}`;
    return new Promise<ControlReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ outcome: 'unconfirmed' });
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      try {
        write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`);
      } catch {
        this.finish(requestId, { outcome: 'unconfirmed' });
      }
    });
  }

  /**
   * Строка от CLI — ответ на наш запрос? Тогда закрывает его и возвращает
   * `true`: дальше по ходу она не идёт.
   */
  settle(raw: { type?: unknown; response?: unknown }): boolean {
    if (raw.type !== 'control_response') return false;
    const response = (raw.response ?? {}) as {
      subtype?: unknown;
      request_id?: unknown;
      error?: unknown;
    };
    const requestId = typeof response.request_id === 'string' ? response.request_id : '';
    if (!this.pending.has(requestId)) return false;
    this.finish(
      requestId,
      response.subtype === 'error'
        ? {
            outcome: 'error',
            message: typeof response.error === 'string' ? response.error : 'error',
          }
        : { outcome: 'ok' },
    );
    return true;
  }

  /** Процесс закрылся: ждать ответов некому. */
  failAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.finish(requestId, { outcome: 'unconfirmed' });
    }
  }

  private finish(requestId: string, reply: ControlReply): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }
}
