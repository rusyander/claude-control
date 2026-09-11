import type { AppState } from './app-store.types.ts';
import type { PlatformAppliedRecord } from '@agentdeck/contracts';

/**
 * След применения контура — что панель записала в чужие конфиги и что было в
 * них ДО неё.
 *
 * Живёт в состоянии панели, а не в настройках, и это разделение существенное:
 * настройки уезжают экспортом на другую машину, а след применения к ней не
 * относится вовсе — там другие файлы, другие пути и, возможно, другие CLI.
 * Перенести его значило бы предложить откат по чужим следам.
 *
 * Секрета в записи нет: ключ контура в чужие конфиги не пишется никогда, а
 * заглушка секретом не является — она для того и придумана.
 */

export function getPlatformApplied(state: AppState): Record<string, PlatformAppliedRecord> {
  return structuredClone(state.platformApplied ?? {});
}

export function savePlatformApplied(
  state: AppState,
  id: string,
  record: PlatformAppliedRecord,
): void {
  state.platformApplied ??= {};
  state.platformApplied[id] = record;
}

/** Контур отключён или удалён — след уходит вместе с ним. */
export function forgetPlatformApplied(state: AppState, id: string): boolean {
  if (!state.platformApplied || !(id in state.platformApplied)) return false;
  delete state.platformApplied[id];
  return true;
}
