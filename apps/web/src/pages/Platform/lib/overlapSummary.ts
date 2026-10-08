import type { PlatformRuleConflict } from '@agentdeck/contracts';

/** Сводка для карточки: сколько пересечений и сколько спорят прямо сейчас. */
export function overlapSummary(conflicts: readonly PlatformRuleConflict[] = []): {
  total: number;
  active: number;
} {
  return {
    total: conflicts.length,
    active: conflicts.filter((cell) => cell.active && !cell.offBy).length,
  };
}
