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

/**
 * Ключ приходит из адреса запроса: `__proto__` или `constructor` находили
 * прототип объекта вместо записи, и маршрут падал 500 вместо 404 (ревью B1-F10).
 */
export function getSplitPlan(state: AppState, parentChatId: string): SplitPlanRecord | undefined {
  const key = currentParent(state, parentChatId);
  return state.splitPlans && Object.hasOwn(state.splitPlans, key)
    ? state.splitPlans[key]
    : undefined;
}

export function setSplitPlan(state: AppState, record: SplitPlanRecord): void {
  if (!state.splitPlans) state.splitPlans = {};
  // Ход, начатый до переезда родителя, несёт прежний ключ — пишем туда, где
  // запись живёт теперь, иначе рядом выросла бы вторая, устаревшая.
  const parent = currentParent(state, record.parentChatId);
  state.splitPlans[parent] =
    parent === record.parentChatId ? record : { ...record, parentChatId: parent };
  prune(state);
}

/** Ключ, под которым запись родителя живёт сейчас, — по цепочке переездов. */
export function currentParent(state: AppState, parentChatId: string): string {
  let key = parentChatId;
  const seen = new Set<string>();
  const moves = state.splitPlanMoves ?? {};
  while (Object.hasOwn(moves, key) && moves[key] && !seen.has(key)) {
    seen.add(key);
    key = moves[key] as string;
  }
  return key;
}

/**
 * Разделение переезжает к продолжению родителя (замечание живого прогона
 * 25.09): переполненный родитель не принимал ни одного сообщения, а свежая
 * сессия без записи не знала бы своих групп — ни сводки, ни `agentdeck:tell`,
 * ни хаба. Переезжает новейшая запись под любым из ключей закрываемого
 * разговора; связи групп (и снятые тоже) переводятся на нового родителя.
 * Ничего не делает, если записи нет или у нового ключа уже своя.
 */
export function moveSplitPlan(state: AppState, from: readonly string[], to: string): boolean {
  const record = Object.values(state.splitPlans ?? {})
    .filter((item) => item.parentChatId !== to && from.includes(item.parentChatId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!record || !state.splitPlans || state.splitPlans[to]) return false;
  const previous = record.parentChatId;
  delete state.splitPlans[previous];
  state.splitPlans[to] = { ...record, parentChatId: to };
  state.splitPlanMoves = { ...state.splitPlanMoves, [previous]: to };
  // Сигналы сторожа живут своим срезом (F-42) — едут вместе с записью.
  const signals = state.groupWatchSignals;
  if (signals && Object.hasOwn(signals, previous) && !Object.hasOwn(signals, to)) {
    const moved = signals[previous];
    delete signals[previous];
    if (moved) signals[to] = moved;
  }
  for (const link of Object.values(state.chatLinks ?? {})) {
    if (link.parentChatId === previous) link.parentChatId = to;
  }
  return true;
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
  for (const key of ordered.slice(0, keys.length - MAX_RECORDS)) {
    delete records[key];
    // Сигналам вытесненной записи показываться негде (срез сторожа, F-42).
    if (state.groupWatchSignals) delete state.groupWatchSignals[key];
  }
  // Переезды к вытесненным записям больше некуда вести.
  const moves = state.splitPlanMoves;
  if (!moves) return;
  for (const [from, to] of Object.entries(moves)) {
    if (!records[currentParent(state, to)]) delete moves[from];
  }
}
