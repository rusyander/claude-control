import { groupKeyOf } from '@agentdeck/contracts';
import { useProjectGroupChoice, type GroupListItem } from '@entities/Group';
import { projectPathOf } from './sections';

/**
 * Какая сторона связанной пары действует в проекте: её порядок работы и
 * состав показывают карточка и окно. Выбора ещё не было — действует то, что
 * было в проекте до копии: оригинал.
 *
 * Выбор у каждой пары свой: запрос называет пару id её проектной стороны. Без
 * имени сервер отвечает выбором «единственной пары», и в проекте с двумя парами
 * это `null` — карточка второй пары показывала не ту сторону (F-113).
 */
export function usePairSide(group: GroupListItem, pair: GroupListItem | undefined) {
  const pairPath = pair ? projectPathOf(pair) : undefined;
  const choice = useProjectGroupChoice(pairPath, pairPath ? pair?.id : undefined);
  const isGlobalActive =
    pair && choice.data ? choice.data.groupKey === groupKeyOf(group) : undefined;
  const shown = pair && isGlobalActive === false ? pair : group;
  return { pairPath, isGlobalActive, isError: choice.isError, shown };
}
