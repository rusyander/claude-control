import type { TrackerTransport } from '@agentdeck/trackers/client.types';
import type { NetFetch } from '../../platform/net/net.types.ts';

/**
 * Транспорт трекера поверх сети ядра (`createCaFetch`: свой корень доверия, прокси окружения):
 * один запрос со сроком, ответ любого кода как есть. Бросает только когда до трекера не дошли
 * (сеть, срок) — заголовков и тела в тексте исключения нет.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT = 4_000_000;
/** Потолок `Retry-After`: враждебный или ошибочный заголовок не замораживает источник надолго. */
export const RETRY_AFTER_CAP_MS = 3_600_000;

/**
 * `Retry-After` в мс: секунды или HTTP-дата (RFC 9110 §10.2.3); негодное — `undefined`
 * (трекер не сказал), прошедшая дата — 0, больше потолка — потолок.
 */
export function retryAfterMsOf(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  let ms: number;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1_000;
  else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  }
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

export function coreTransport(fetch: NetFetch, timeoutMs = DEFAULT_TIMEOUT_MS): TrackerTransport {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const retryAfterMs = response.ok
      ? undefined
      : retryAfterMsOf(response.headers?.get?.('retry-after'));
    return {
      status: response.status,
      ok: response.ok,
      text: text.slice(0, MAX_TEXT),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  };
}

/** Почему до трекера не дошли: имя ошибки и сетевой код, без адреса запроса и заголовков. */
export function describeTransport(error: unknown): string {
  if (!(error instanceof Error)) return 'unreachable';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
  const code =
    (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === 'string' ? `unreachable (${code})` : 'unreachable';
}
