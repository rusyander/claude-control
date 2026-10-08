import type { WatcherStatus } from '@agentdeck/contracts';

/**
 * Сколько наблюдатель работает. Считается от часов СЕРВЕРА: `since` и
 * `serverNow` пришли из одного ответа, их разница не зависит от того, спешат
 * ли часы браузера (телефон, другая машина через туннель). Дальше тикает
 * локально раз в секунду.
 */
export function elapsedMs(
  status: Pick<WatcherStatus, 'since' | 'serverNow'>,
  receivedAt: number,
  now: number,
): number {
  if (!status.since) return 0;
  const atResponse = Date.parse(status.serverNow) - Date.parse(status.since);
  return Math.max(0, atResponse + (now - receivedAt));
}
