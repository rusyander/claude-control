import type { WatcherSpend, WatcherStatus } from '@agentdeck/contracts';
import { formatSpend, type CostUnit } from '../../shared/lib/format';

/**
 * Фоновый наблюдатель панели — разбор ответа `GET /api/watcher` без React:
 * его и проверяют тесты. Тип из контрактов берётся только типом: модуль
 * `watcher.ts` тянет zod, в сборку телефона ему нельзя.
 */

/** Значок на главной — только у включённого: выключенный ничего не собирает. */
export function watcherVisible(status: WatcherStatus | undefined): status is WatcherStatus {
  return status?.enabled === true;
}

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

/** Как в панели: `4с`, `1м 12с`, `1ч 03м` — два разряда, минуты при часах с нулём. */
export function formatUptime(ms: number, units: { h: string; m: string; s: string }): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}${units.s}`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}${units.m} ${String(total % 60).padStart(2, '0')}${units.s}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${units.h} ${String(minutes % 60).padStart(2, '0')}${units.m}`;
}

/**
 * Расход в единицах, выбранных в панели. Деньги — только когда модель нашлась
 * в прайсе, и всегда с пометкой «оценка»: при подписке токены не списываются.
 */
export function watcherSpendText(
  spend: WatcherSpend,
  unit: CostUnit,
): { text: string; estimate: boolean } {
  const tokens = spend.input + spend.output + spend.cacheRead + spend.cacheCreation;
  if (unit === 'money' && spend.estimatedUsd !== undefined) {
    return { text: formatSpend('money', tokens, spend.estimatedUsd), estimate: true };
  }
  return { text: formatSpend('tokens', tokens, 0), estimate: false };
}
