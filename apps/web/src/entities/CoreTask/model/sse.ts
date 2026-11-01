import { SSE_PING_MS } from '@agentdeck/contracts/core/panel-api';

/**
 * Поток событий задачи ядра (`GET /api/core/tasks/:id/events`) читается через `fetch`, а не
 * `EventSource`: заголовок `Last-Event-ID` при возобновлении ставит сам клиент, и обрыв
 * (перезапуск панели или ядра, сон ноутбука) не теряет строк и не повторяет их — ядро отдаёт
 * хвост журнала после последнего полученного номера.
 */

export interface SseEvent {
  /** `id:` — номер строки журнала; нет — событие без номера. */
  id?: string;
  /** `event:` — вид строки журнала; по умолчанию `message`. */
  event: string;
  data: string;
}

/**
 * Разбор SSE по кускам сети: кадр кончается пустой строкой, кусок может оборваться посреди
 * строки или посреди кадра. Комментарии (`: ping`) событий не дают.
 */
export function createSseParser() {
  let buffer = '';
  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseFrame(frame);
        if (event) events.push(event);
      }
      return events;
    },
  };
}

function parseFrame(frame: string): SseEvent | undefined {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return { ...(id !== undefined ? { id } : {}), event, data: data.join('\n') };
}

export interface FollowEventsOptions {
  url: string;
  /** Номер последней уже показанной строки: поток начнётся после неё. */
  lastEventId?: string;
  signal: AbortSignal;
  onEvent(event: SseEvent): void;
  /** Ответ не 200 (задачи нет, ядро не подтвердило себя): поток не возобновляется сам. */
  onRefusal?(status: number, body: string): void;
  /** Обрыв, после которого поток возобновится через `delayMs`. */
  onDrop?(reason: string, delayMs: number): void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Пауза перед повтором после N обрывов подряд. */
  backoffMs?: (attempt: number) => number;
  /** Сколько поток может молчать (ни строки, ни `: ping`), прежде чем считаться оборванным. */
  idleMs?: number;
}

/**
 * Молчание дольше двух пингов ядра и запаса — соединение мертво, даже если ОС этого не сказала:
 * сон ноутбука, смена сети, прокси, державший сокет открытым без данных. Без сторожа лента
 * висела бы на таком сокете вечно — ни ошибки, ни переподключения.
 */
const DEFAULT_IDLE_MS = 2 * SSE_PING_MS + 5_000;

const defaultBackoff = (attempt: number) => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

/** Номер строки журнала из `id:`; не число — `undefined` (такое событие повтором не судится). */
const seqOf = (id: string | undefined): number | undefined => {
  if (id === undefined || !/^\d+$/.test(id)) return undefined;
  return Number(id);
};

/**
 * Ведёт поток, пока не отменён `signal`: обрыв сети, конец ответа или молчание дольше `idleMs` —
 * повтор с `Last-Event-ID` последнего полученного номера; отказ (не 200) — конец, решает
 * вызывающий. Строка с номером не больше уже отданного не отдаётся второй раз (звено, не
 * понявшее `Last-Event-ID`, повторило бы хвост целиком). Ответ — номер последнего события.
 */
export async function followCoreEvents(options: FollowEventsOptions): Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const backoff = options.backoffMs ?? defaultBackoff;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  let lastId = options.lastEventId;
  let attempt = 0;
  while (!options.signal.aborted) {
    let reason: string;
    // Своя отмена на каждую попытку: сторож молчания рвёт только её, а не весь поток.
    const attemptAbort = new AbortController();
    const stopAttempt = () => attemptAbort.abort();
    options.signal.addEventListener('abort', stopAttempt, { once: true });
    let idle = false;
    let cancelRead: (() => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        idle = true;
        attemptAbort.abort();
        cancelRead?.();
      }, idleMs);
    };
    try {
      arm();
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (lastId !== undefined) headers['last-event-id'] = lastId;
      const res = await fetchImpl(options.url, { headers, signal: attemptAbort.signal });
      if (res.status !== 200 || !res.body) {
        options.onRefusal?.(res.status, await res.text().catch(() => ''));
        return lastId;
      }
      const parser = createSseParser();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      cancelRead = () => void reader.cancel().catch(() => {});
      arm();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // Любой кусок — и строка, и `: ping` — знак, что соединение живо.
        arm();
        for (const event of parser.push(value)) {
          const seq = seqOf(event.id);
          const seen = seqOf(lastId);
          if (seq !== undefined && seen !== undefined && seq <= seen) continue;
          if (event.id !== undefined) lastId = event.id;
          attempt = 0;
          options.onEvent(event);
        }
      }
      reason = idle ? `idle ${idleMs} ms` : 'stream ended';
    } catch (error) {
      if (options.signal.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      reason = idle ? `idle ${idleMs} ms` : message;
    } finally {
      clearTimeout(watchdog);
      options.signal.removeEventListener('abort', stopAttempt);
    }
    const delay = backoff(attempt);
    attempt += 1;
    options.onDrop?.(reason, delay);
    await sleep(delay, options.signal);
  }
  return lastId;
}
