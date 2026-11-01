import type { TaskListItem } from '@agentdeck/contracts/core/panel-api';
import type { AskState } from '@agentdeck/contracts/core/states';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { AskCardAsk } from '@features/CoreAsk';
import type { AskFact, TimelineFold } from '@features/CoreTimeline';

export interface OpenAsk {
  ask: AskCardAsk;
  state: AskState | null;
}

/**
 * Вопросы, которые ждут человека: факты вопроса — из ленты (там текст, варианты, цель права),
 * состояние — из вида ядра (там закрытие по ответу, сроку или снятию). Вида ещё нет — вопрос без
 * ответа в ленте считается открытым, иначе карточка мигала бы до первой перечитки вида.
 */
export function openAsks(fold: TimelineFold, view: TaskView | undefined): OpenAsk[] {
  const states = new Map((view?.asks ?? []).map((a) => [a.askId, a.state]));
  const facts: AskFact[] = Object.values(fold.asks).sort((a, b) => a.seq - b.seq);
  const out: OpenAsk[] = [];
  for (const fact of facts) {
    const state = states.get(fact.askId) ?? (fact.answer ? 'answered' : null);
    if (state === null || state === 'open') out.push({ ask: fact, state });
  }
  return out;
}

/** Название задачи из строки `task.created`; `null` — строка ещё не пришла. */
export function taskTitle(fold: TimelineFold): string | null {
  for (const row of fold.rows) {
    if (row.item.type === 'task-created' && row.item.title) return row.item.title;
  }
  return null;
}

export type StreamState = 'live' | 'dropped' | 'refused';

/** Состояние потока ленты: отказ ядра важнее обрыва — переподключение его не исправит. */
export function streamState(refusal: number | undefined, dropped: boolean): StreamState {
  if (refusal !== undefined) return 'refused';
  return dropped ? 'dropped' : 'live';
}

/**
 * «Идёт» в списке задач. `live` у ядра — журнал задачи открыт в этом процессе, а закончившаяся
 * задача остаётся открытой до выгрузки: по одному `live` отменённая задача числилась бы идущей.
 */
export function isRunning(task: Pick<TaskListItem, 'live' | 'ended'>): boolean {
  return task.live && task.ended === null;
}
