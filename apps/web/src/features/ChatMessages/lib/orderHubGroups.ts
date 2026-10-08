import type { ChildStageGroup } from '../ui/ChildStages.types';
import { isTriageRow } from './hubSummary';
import { isMrSettled } from './isMrSettled';
import { isFinishedGroup } from './hubOrder';

/**
 * Порядок карточек хаба (G2, владелец 05.10.2026): то, что ещё в работе
 * (идёт, стоит, ждёт человека, на паузе, оборвано, в очереди), — сверху,
 * законченное — ниже, а группы с влитым или закрытым MR — в самом низу
 * (06.10.2026): доставленная, но не влитая группа ещё ждёт слияния, и её не
 * должно быть видно хуже влитых. Внутри каждой части порядок прежний — порядок
 * плана: карточки не прыгают между перерисовками. Строка разбора — общая на
 * всё разделение, она остаётся первой, чем бы ни кончилась.
 */
export function orderHubGroups(groups: readonly ChildStageGroup[]): ChildStageGroup[] {
  const triage = groups.filter(isTriageRow);
  const rest = groups.filter((group) => !isTriageRow(group));
  return [
    ...triage,
    ...rest.filter((group) => !isFinishedGroup(group)),
    ...rest.filter((group) => isFinishedGroup(group) && !isMrSettled(group)),
    ...rest.filter(isMrSettled),
  ];
}
