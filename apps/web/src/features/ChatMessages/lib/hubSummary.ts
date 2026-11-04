import type { ChildStageGroup } from '../ui/ChildStages.types';
import type { HubBucket } from './hubSummary.types';

export const HUB_BUCKETS: readonly HubBucket[] = ['running', 'ask', 'idle'];

/** Строка разбора — общая на всё разделение, группой она не считается. */
export function isTriageRow(group: ChildStageGroup): boolean {
  return group.stages.includes('triage');
}
