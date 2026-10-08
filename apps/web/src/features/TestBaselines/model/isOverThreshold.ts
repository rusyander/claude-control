import type { ProjectTestBaseline } from '@agentdeck/contracts';

/** Превышен ли порог. Порога нет — судить не о чем, и мы этого не выдумываем. */
export function isOverThreshold(point: ProjectTestBaseline): boolean {
  if (point.diffRatio === undefined || point.maxDiffRatio === undefined) return false;
  return point.diffRatio > point.maxDiffRatio;
}
