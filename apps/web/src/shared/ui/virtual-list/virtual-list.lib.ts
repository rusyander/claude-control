/**
 * Сколько просьба прокрутить к строке ждёт саму строку. Строка, скрытая сейчас
 * фильтром, держала просьбу вечно: когда фильтр потом возвращал её, список сам
 * прыгал к ней посреди чужой работы (F-339).
 */
export const SCROLL_REQUEST_TTL_MS = 5000;

export type ScrollDecision = 'scroll' | 'wait' | 'drop';

/**
 * Что делать с просьбой прокрутить: строка есть — прокрутить; строки ещё нет —
 * ждать (данные догружаются), но не дольше `SCROLL_REQUEST_TTL_MS` от просьбы;
 * дальше — забыть, даже если строка появится.
 */
export function scrollDecision(input: {
  index: number;
  requestedAt: number;
  now: number;
  ttlMs?: number;
}): ScrollDecision {
  const expired = input.now - input.requestedAt > (input.ttlMs ?? SCROLL_REQUEST_TTL_MS);
  if (expired) return 'drop';
  return input.index < 0 ? 'wait' : 'scroll';
}
