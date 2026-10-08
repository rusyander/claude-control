import type { ChildStageGroup } from '../ui/ChildStages.types';
import { hubBucket } from './hubBucket';

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
