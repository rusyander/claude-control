import type { ChildStageGroup } from '../ui/ChildStages.types';
import { hubBucket, isTriageRow } from './hubSummary';

/**
 * Группа закончена: работы по ней больше не будет, осталось только влить MR
 * или уже нечего делать. Доставлена («готово»), принята, закрыта отменой плана,
 * её MR влит или закрыт, копия убрана. Идущая группа не закончена никогда —
 * даже с влитым MR (перепроверка, правки по ревью).
 */
export function isFinishedGroup(group: ChildStageGroup): boolean {
  if (group.isRunning || group.pending === 'setup') return false;
  if (group.mrClosed || group.copy?.cleaned) return true;
  const bucket = hubBucket(group);
  return bucket === 'done' || bucket === 'accepted' || bucket === 'cancelled';
}

/**
 * MR группы влит или закрыт, и группа не работает: с ней всё — даже слияние.
 * Такая карточка перекрашена и стоит в самом низу (владелец 06.10.2026).
 */
export function isMrSettled(group: ChildStageGroup): boolean {
  return Boolean(group.mrClosed) && !group.isRunning && group.pending !== 'setup';
}

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
