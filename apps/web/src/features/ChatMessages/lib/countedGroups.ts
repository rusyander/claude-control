import type { ChildStageGroup } from '../ui/ChildStages.types';
import { isTriageRow } from './hubSummary';

/** Строки, которые считаются группами: без разбора и без отброшенных чатов. */
export function countedGroups(groups: ChildStageGroup[]): ChildStageGroup[] {
  return groups.filter((group) => !group.retired && !isTriageRow(group));
}
