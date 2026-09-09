import type { AppState, TreePauseRecord } from './app-store.types.ts';

/**
 * Записи паузы деревьев разговоров: корень → что остановлено и что отложено.
 *
 * Потолок нужен той же природы, что и у связей: запись живёт до «Продолжить
 * всё», а человек волен остановить дерево и забыть о нём. Пятьдесят стоящих
 * деревьев одновременно — уже не рабочее состояние, а мусор, и старейшие
 * уходят первыми.
 */
const MAX_RECORDS = 50;

export function getTreePauses(state: AppState): Record<string, TreePauseRecord> {
  return state.treePause ?? {};
}

export function getTreePause(state: AppState, root: string): TreePauseRecord | undefined {
  return state.treePause?.[root];
}

export function setTreePause(state: AppState, record: TreePauseRecord): void {
  if (!state.treePause) state.treePause = {};
  state.treePause[record.root] = record;
  prune(state);
}

/** Снять паузу; `false` — записи не было, сохранять нечего. */
export function clearTreePause(state: AppState, root: string): boolean {
  if (!state.treePause?.[root]) return false;
  delete state.treePause[root];
  return true;
}

function prune(state: AppState): void {
  const records = state.treePause ?? {};
  const keys = Object.keys(records);
  if (keys.length <= MAX_RECORDS) return;
  const ordered = keys.sort((a, b) => (records[a]?.at ?? '').localeCompare(records[b]?.at ?? ''));
  for (const key of ordered.slice(0, keys.length - MAX_RECORDS)) delete records[key];
}
