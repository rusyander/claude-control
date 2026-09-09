import type { AppState, SplitPlanRecord } from './app-store.types.ts';

/**
 * Записи конвейера уровней разделения (Т1): родительский разговор → что
 * попросили, что ответил разбор, где каждая группа.
 *
 * Потолок той же природы, что у пауз: запись нужна, пока группы ждут разбора,
 * ответа человека или предшественников, а человек волен забыть разделение
 * на полпути. Полсотни живых разделений разом — не рабочее состояние.
 */
const MAX_RECORDS = 50;

export function getSplitPlans(state: AppState): Record<string, SplitPlanRecord> {
  return state.splitPlans ?? {};
}

export function getSplitPlan(state: AppState, parentChatId: string): SplitPlanRecord | undefined {
  return state.splitPlans?.[parentChatId];
}

export function setSplitPlan(state: AppState, record: SplitPlanRecord): void {
  if (!state.splitPlans) state.splitPlans = {};
  state.splitPlans[record.parentChatId] = record;
  prune(state);
}

/** Запись по чату разбора (уровень 1): его завершение ищет свой конвейер. */
export function findSplitPlanByTriage(
  state: AppState,
  chatIds: readonly string[],
): SplitPlanRecord | undefined {
  return Object.values(state.splitPlans ?? {}).find(
    (record) => record.triageChatId && chatIds.includes(record.triageChatId),
  );
}

function prune(state: AppState): void {
  const records = state.splitPlans ?? {};
  const keys = Object.keys(records);
  if (keys.length <= MAX_RECORDS) return;
  const ordered = keys.sort((a, b) =>
    (records[a]?.createdAt ?? '').localeCompare(records[b]?.createdAt ?? ''),
  );
  for (const key of ordered.slice(0, keys.length - MAX_RECORDS)) delete records[key];
}
