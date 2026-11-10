import { useEffect, useState } from 'react';

/** Предел таймера браузера (мс): дальше `setTimeout` срабатывает сразу. */
const TIMER_MAX = 2 ** 31 - 1;

/**
 * Значок «лимит до чч:мм» в шапке чата виден, пока момент сброса впереди (ревью этапа 12). Окно
 * открылось — подпись больше не правда: после сброса ядро само шлёт слово ещё раз, а событие
 * `limit` прогона панели так и стоит с прежним сбросом. Сброс неизвестен (`0`) — значка нет:
 * «лимит до 05:00» по нулевой метке ничего не значит.
 */
export function limitChipShown(resetsAt: number | undefined, nowMs: number): boolean {
  return resetsAt !== undefined && resetsAt > 0 && resetsAt * 1000 > nowMs;
}

/** То же правило со временем, которое идёт: на моменте сброса шапка перерисовывается сама. */
export function useLimitChip(resetsAt: number | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!resetsAt) return;
    const left = Math.max(0, resetsAt * 1000 - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.min(left + 50, TIMER_MAX));
    return () => clearTimeout(timer);
  }, [resetsAt]);
  return limitChipShown(resetsAt, now);
}
