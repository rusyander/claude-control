import type { HubBucket } from './hubSummary.types';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { countedGroups } from './countedGroups';
import { hubBucket } from './hubBucket';

export interface HubSummary {
  counts: Record<HubBucket, number>;
  /** Сколько идёт разделение (мс): от первого звена до «сейчас» или до последней записи. */
  elapsedMs?: number;
}

/**
 * Счётчики и время. Время — от самого раннего звена (обычно разбора) до
 * «сейчас», пока хоть что-то идёт; когда всё стоит — до последней записи:
 * иначе остановленное разделение «шло» бы вечно.
 */
export function summarizeHub(groups: ChildStageGroup[], now: number): HubSummary {
  const counts: Record<HubBucket, number> = {
    accepted: 0,
    done: 0,
    running: 0,
    ask: 0,
    queued: 0,
    failed: 0,
    cancelled: 0,
    idle: 0,
  };
  for (const group of countedGroups(groups)) counts[hubBucket(group)] += 1;

  const live = groups.filter((group) => !group.retired);
  const starts = live.map((group) => Date.parse(group.startedAt ?? '')).filter(Number.isFinite);
  if (starts.length === 0) return { counts };
  const start = Math.min(...starts);
  const lasts = live.map((group) => Date.parse(group.lastAt ?? '')).filter(Number.isFinite);
  const end = live.some((group) => group.isRunning) ? now : Math.max(start, ...lasts);
  return { counts, elapsedMs: Math.max(0, end - start) };
}
