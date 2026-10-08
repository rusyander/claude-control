import type { WatcherStatus } from '@agentdeck/contracts';

/**
 * Сколько наблюдатель работает. Отсчёт — по часам сервера на момент ответа
 * плюс сколько прошло с его получения: часы телефона могут отставать от
 * компьютера на минуты, и «работает −3 мин» было бы неправдой.
 */
export function watcherElapsedMs(
  status: Pick<WatcherStatus, 'since' | 'serverNow'>,
  receivedAt: number,
  now: number,
): number {
  if (!status.since) return 0;
  const atResponse = Date.parse(status.serverNow) - Date.parse(status.since);
  if (Number.isNaN(atResponse)) return 0;
  return Math.max(0, atResponse + (now - receivedAt));
}
