import type { ChildStageGroup } from '../ui/ChildStages.types';
import { isTriageRow } from './hubSummary';

/**
 * Порядок карточек хаба: строка разбора — общая на всё разделение, она первая;
 * остальные группы — в порядке плана, чтобы карточки не прыгали между
 * перерисовками.
 */
export function orderHubGroups(groups: readonly ChildStageGroup[]): ChildStageGroup[] {
  return [...groups.filter(isTriageRow), ...groups.filter((group) => !isTriageRow(group))];
}
