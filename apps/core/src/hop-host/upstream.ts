import { redactSecrets } from '@agentdeck/dlp/redact';
import { hopText } from './gateway/texts.ts';

/**
 * Поход наверх — единственное место звена, где ключ попадает в запрос (перенос
 * `gateway/upstream` панели без CA-транспорта: свой корень компании и прокси — дело маршрута
 * контура, зона R). Правила те же, что у панели:
 *
 * 1. Адрес — только из регистрации сеанса; перенаправление — ОТКАЗ с названным адресом: пойти
 *    по `Location` значило бы отправить промпт туда, куда человек его не посылал.
 * 2. Ключ — одним заголовком, и больше никуда: ни в адрес, ни в след, ни в текст отказа
 *    (отражённый вендором ключ вычищается `redactSecrets`).
 * 3. Повтор ровно ОДИН и только по коду ответа 429/5xx, до первого байта клиенту. Обрыв связи не
 *    повторяется: запрос мог дойти и исполниться, второй такой же — второе списание (P122).
 */

/** Пауза перед единственной повторной попыткой, когда вендор её не назвал. */
export const UPSTREAM_RETRY_PAUSE_MS = 700;
/** Дольше не ждём: названная пауза сверх потолка значит «не сегодня», ответ уходит клиенту. */
const UPSTREAM_RETRY_MAX_PAUSE_MS = 2_000;

export interface HopUpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Уход клиента и тишина наверху — оба обрывают запрос. */
  signal: AbortSignal;
  /** Сколько ждать заголовков ответа (мс). */
  headersTimeoutMs: number;
  /** Ключ запроса — чтобы вычистить его из текста ошибки, если вендор его отразил. */
  secret?: string;
  retryPauseMs?: number;
  /** Выключает повтор; по умолчанию он есть. */
  retry?: boolean;
  fetchImpl?: typeof fetch;
}

export type UpstreamFailureKind = 'connection' | 'timeout' | 'redirect' | 'other';

export class UpstreamError extends Error {
  readonly kind: UpstreamFailureKind;
  constructor(message: string, kind: UpstreamFailureKind) {
    super(message);
    this.kind = kind;
  }
}

export interface UpstreamReply {
  response: Response;
  /** Ответ — со второй попытки. */
  retried: boolean;
}

/** Ждать ли повтора и сколько; `null` — не повторяем. */
export function retryPauseMs(
  response: Pick<Response, 'status' | 'headers'>,
  fallbackMs = UPSTREAM_RETRY_PAUSE_MS,
  now = Date.now(),
): number | null {
  if (response.status !== 429 && response.status < 500) return null;
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return fallbackMs;
  const seconds = Number(header);
  const waitMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  if (!Number.isFinite(waitMs)) return fallbackMs;
  if (waitMs > UPSTREAM_RETRY_MAX_PAUSE_MS) return null;
  return Math.max(waitMs, 0);
}

/** Через сколько секунд вендор разрешает повторить — для ТЕКСТА отказа. */
export function retryAfterSeconds(
  response: Pick<Response, 'headers'>,
  now = Date.now(),
): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  const waitMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  if (!Number.isFinite(waitMs) || waitMs <= 0) return undefined;
  return Math.ceil(waitMs / 1_000);
}

function failureKind(error: unknown): UpstreamFailureKind {
  const chain: string[] = [];
  for (let item: unknown = error, depth = 0; item && depth < 4; depth += 1) {
    if (item instanceof Error) {
      chain.push(item.message, (item as { code?: string }).code ?? '');
      item = (item as { cause?: unknown }).cause;
    } else {
      chain.push(String(item));
      break;
    }
  }
  return /ECONNREFUSED|ECONNRESET|EPIPE|ECONNABORTED|socket hang up|other side closed|UND_ERR_SOCKET/i.test(
    chain.join(' '),
  )
    ? 'connection'
    : 'other';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function attempt(call: HopUpstreamCall): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  // Потолок стоит на ЗАГОЛОВКАХ: дальше поток идёт сколько угодно, его тишину меряет читатель.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, call.headersTimeoutMs);
  const onAbort = (): void => controller.abort(call.signal.reason);
  if (call.signal.aborted) controller.abort(call.signal.reason);
  else call.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await (call.fetchImpl ?? fetch)(call.url, {
      method: call.method,
      headers: call.headers,
      ...(call.body !== undefined ? { body: call.body } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      let where = '';
      try {
        const location = response.headers.get('location');
        if (location) where = new URL(location, call.url).origin;
      } catch {
        where = '';
      }
      throw new UpstreamError(
        where
          ? hopText('gateway-redirect-to', { where, status: response.status })
          : hopText('gateway-redirect', { status: response.status }),
        'redirect',
      );
    }
    return response;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (timedOut)
      throw new UpstreamError(
        hopText('gateway-headers-timeout', { seconds: Math.round(call.headersTimeoutMs / 1_000) }),
        'timeout',
      );
    const reason = redactSecrets(
      error instanceof Error ? error.message : String(error),
      call.secret,
    ).slice(0, 200);
    throw new UpstreamError(hopText('gateway-no-connection', { reason }), failureKind(error));
  } finally {
    clearTimeout(timer);
  }
}

export async function callUpstream(call: HopUpstreamCall): Promise<UpstreamReply> {
  const first = await attempt(call);
  if (call.retry === false) return { response: first, retried: false };
  const pause = retryPauseMs(first, call.retryPauseMs ?? UPSTREAM_RETRY_PAUSE_MS);
  if (pause === null) return { response: first, retried: false };
  // Тело первого ответа читать некому, а брошенный поток остался бы открытым сокетом.
  await first.body?.cancel().catch(() => undefined);
  await sleep(pause, call.signal);
  return { response: await attempt(call), retried: true };
}

/**
 * Читатель потока с присмотром за тишиной: нет следующего куска дольше `stallMs` — поток
 * наверху обрывается и возвращается `stalled`. Без этого зависший вендор держал бы клиента вечно.
 */
export async function pumpWithStall(
  body: ReadableStream<Uint8Array> | null,
  stallMs: number,
  abort: () => void,
  onText: (text: string) => void | Promise<void>,
  gone: () => boolean,
): Promise<'done' | 'stalled' | 'gone'> {
  if (!body) return 'done';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    if (gone()) {
      await reader.cancel().catch(() => undefined);
      return 'gone';
    }
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<'stalled'>((resolve) => {
      timer = setTimeout(() => resolve('stalled'), stallMs);
    });
    const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
    if (next === 'stalled') {
      abort();
      await reader.cancel().catch(() => undefined);
      return 'stalled';
    }
    if (next.done) break;
    const text = decoder.decode(next.value, { stream: true });
    if (text) await onText(text);
  }
  const tail = decoder.decode();
  if (tail) await onText(tail);
  return 'done';
}
