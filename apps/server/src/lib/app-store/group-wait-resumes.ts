import type { AppState, GroupWaitResumeRecord } from './app-store.types.ts';
import { getSplitPlan } from './split-plans.ts';

/**
 * Срез счёта продолжений группы «по плану» (F-87): номер сессии → сколько раз
 * подряд панель продолжила ход, кончившийся ожиданием ответа текстом. Пишет
 * только `group-wait.ts` через сборку; конвейер разделения его не касается.
 *
 * Срез конечен: счёт кончившейся группы (`done`/`failed`, запись разделения ушла)
 * стирается на каждой записи, а живых больше потолка не бывает — сверх него уходят
 * самые старые.
 */
export const GROUP_WAIT_RESUMES_MAX = 100;

export function getGroupWaitResume(
  state: AppState,
  conversation: string,
): GroupWaitResumeRecord | undefined {
  const resumes = state.groupWaitResumes;
  if (!resumes || !Object.hasOwn(resumes, conversation)) return undefined;
  const record = resumes[conversation];
  // Ручная правка `state.json` могла оставить что угодно — битый счёт как нет счёта.
  return record && Number.isInteger(record.count) && record.count > 0 ? record : undefined;
}

/** Кончилась ли группа счёта: записи разделения или группы нет, итог `done`/`failed`. */
function ended(state: AppState, record: GroupWaitResumeRecord): boolean {
  const group = getSplitPlan(state, record.parentChatId)?.groups.find(
    (item) => item.index === record.groupIndex,
  );
  return !group || group.status === 'done' || group.status === 'failed';
}

/** Записать счёт сессии; `undefined` — стереть. Заодно уходят счета кончившихся групп. */
export function setGroupWaitResume(
  state: AppState,
  conversation: string,
  record: GroupWaitResumeRecord | undefined,
): void {
  const resumes: Record<string, GroupWaitResumeRecord> = { ...state.groupWaitResumes };
  if (record) resumes[conversation] = record;
  else delete resumes[conversation];
  for (const [key, item] of Object.entries(resumes)) {
    if (!item || ended(state, item)) delete resumes[key];
  }
  const kept = Object.entries(resumes)
    .sort(([, a], [, b]) => b.at.localeCompare(a.at))
    .slice(0, GROUP_WAIT_RESUMES_MAX);
  if (kept.length > 0) state.groupWaitResumes = Object.fromEntries(kept);
  else delete state.groupWaitResumes;
}
