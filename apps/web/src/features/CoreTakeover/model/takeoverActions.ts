import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { TakeoverActions } from './takeoverActions.types';

const ENDED = new Set(['done', 'cancelled', 'failed']);

/**
 * Какие действия перехвата показать на карточке задачи. Судья — ядро (отказ приходит его словами);
 * здесь только не рисуем кнопку, которую ядро заведомо отклонит:
 * - «Взять вручную» — задача идёт или стоит на паузе и перехват ещё не открыт (P161);
 * - «Вернуть ядру» — перехват открыт;
 * - «На доработку» — задача идёт (сообщение живому шагу) или готова с открытым MR (носитель
 *   ответов, P162); во время перехвата человек правит сам, доработка словами не нужна;
 * - точка остановки — пока задача не кончилась и MR ещё нет (после MR ядро отказывает, P157).
 */
export function takeoverActionsOf(card: BoardCard): TakeoverActions {
  if (card.kind !== 'task' || !card.taskId) {
    return { takeOver: false, handBack: false, rework: false, setStop: false };
  }
  const state = card.state ?? '';
  const open = card.takeover !== null;
  const ended = ENDED.has(state);
  return {
    takeOver: !open && (state === 'running' || state === 'paused'),
    handBack: open,
    rework: !open && (state === 'running' || (state === 'done' && card.mr?.state === 'opened')),
    setStop: !ended && card.mr === undefined,
  };
}
