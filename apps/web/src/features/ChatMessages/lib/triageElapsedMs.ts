import type { ChildStageGroup } from '../ui/ChildStages.types';
import { isTriageRow } from './hubSummary';

/**
 * Сколько идёт разбор (L13): он молчит минутами, и без времени его не отличить
 * от зависшего. Только у ИДУЩЕГО прогона разбора: у остановленного «идёт 20м»
 * было бы той же ложью, что и «в работе» (L23).
 */
export function triageElapsedMs(groups: ChildStageGroup[], now: number): number | undefined {
  const triage = groups.find((group) => !group.retired && isTriageRow(group));
  if (!triage?.isRunning || !triage.startedAt) return undefined;
  const start = Date.parse(triage.startedAt);
  return Number.isFinite(start) ? Math.max(0, now - start) : undefined;
}
