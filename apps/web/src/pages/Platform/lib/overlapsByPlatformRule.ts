import type { PlatformRuleConflict } from '@agentdeck/contracts';

/** Пересечения по строке контура: `platformRule` → ячейка матрицы. */
export function overlapsByPlatformRule(
  conflicts: readonly PlatformRuleConflict[] = [],
): Map<string, PlatformRuleConflict> {
  return new Map(conflicts.map((cell) => [cell.platformRule, cell]));
}
