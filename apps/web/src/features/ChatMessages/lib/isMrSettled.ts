import type { ChildStageGroup } from '../ui/ChildStages.types';

/**
 * MR группы влит или закрыт, и группа не работает: с ней всё — даже слияние.
 * Такая карточка перекрашена и стоит в самом низу (владелец 06.10.2026).
 */
export function isMrSettled(group: ChildStageGroup): boolean {
  return Boolean(group.mrClosed) && !group.isRunning && group.pending !== 'setup';
}
