import type { WatcherStatus } from '@agentdeck/contracts';

/**
 * Фоновый наблюдатель панели — разбор ответа `GET /api/watcher` без React:
 * его и проверяют тесты. Тип из контрактов берётся только типом: модуль
 * `watcher.ts` тянет zod, в сборку телефона ему нельзя.
 */

/** Значок на главной — только у включённого: выключенный ничего не собирает. */
export function watcherVisible(status: WatcherStatus | undefined): status is WatcherStatus {
  return status?.enabled === true;
}
