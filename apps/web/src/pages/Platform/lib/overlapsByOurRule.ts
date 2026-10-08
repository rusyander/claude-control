import type { PlatformRuleConflict } from '@agentdeck/contracts';

/** Пересечения по нашей стороне: `ourRule` → ячейка матрицы. */
export function overlapsByOurRule(
  conflicts: readonly PlatformRuleConflict[] = [],
): Map<string, PlatformRuleConflict> {
  return new Map(conflicts.map((cell) => [cell.ourRule, cell]));
}
