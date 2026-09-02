import type { AppState, McpHealthRecord } from './app-store.types.ts';

/**
 * Итог последней проверки связи MCP-серверов — срез состояния панели.
 *
 * Раньше результат жил только в состоянии карточки в браузере: F5 возвращал
 * «не проверялся», а обзор считал отвечающие серверы по списку, в котором
 * health всегда было `unknown`, — счётчик не мог показать ничего, кроме нуля.
 * Здесь запись переживает перезагрузку страницы и перезапуск сервера, а
 * читается там же, где собирается список серверов (`readMcpServers`).
 */

export function getMcpHealth(state: AppState): Record<string, McpHealthRecord> {
  return structuredClone(state.mcpHealth);
}

export function saveMcpHealth(state: AppState, id: string, record: McpHealthRecord): void {
  state.mcpHealth[id] = record;
}

/** Сервер удалён — вместе с ним уходит и след проверки. */
export function forgetMcpHealth(state: AppState, id: string): boolean {
  if (!(id in state.mcpHealth)) return false;
  delete state.mcpHealth[id];
  return true;
}

/** Переименование сервера: запись переезжает под новое имя, как группы и отметки. */
export function renameMcpHealth(state: AppState, oldId: string, newId: string): boolean {
  const record = state.mcpHealth[oldId];
  if (!record || oldId === newId) return false;
  delete state.mcpHealth[oldId];
  state.mcpHealth[newId] = record;
  return true;
}
