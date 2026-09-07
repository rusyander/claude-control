import type { AppState, IntegrationHealthRecord } from './app-store.types.ts';

/**
 * Итог последней проверки связи с внешними системами — срез состояния панели.
 *
 * Зеркало `mcp-health.ts`, и по той же причине: результат, живущий только в
 * состоянии карточки в браузере, умирает на F5, а страница настроек после
 * перезагрузки показывает «не проверялось» по связи, которая работает. Здесь
 * запись переживает и обновление страницы, и перезапуск сервера.
 *
 * Секрета в записи нет: наружу из проверки уходят только состояние, причина
 * словами и имя учётной записи — то, что панель и так показывает на карточке.
 */

export function getIntegrationHealth(state: AppState): Record<string, IntegrationHealthRecord> {
  return structuredClone(state.integrationHealth ?? {});
}

export function saveIntegrationHealth(
  state: AppState,
  id: string,
  record: IntegrationHealthRecord,
): void {
  state.integrationHealth ??= {};
  state.integrationHealth[id] = record;
}

/** Интеграцию забыли (сняли токен) — вместе с ней уходит и след проверки. */
export function forgetIntegrationHealth(state: AppState, id: string): boolean {
  if (!state.integrationHealth || !(id in state.integrationHealth)) return false;
  delete state.integrationHealth[id];
  return true;
}
