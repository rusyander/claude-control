import type { PlatformRuleConflict } from '@agentdeck/contracts';

/**
 * Нарушенное взаимное исключение — то, из-за чего сохранение получит отказ.
 * Пусто — противоречия нет.
 */
export function blockingConflict(
  conflicts: readonly PlatformRuleConflict[] = [],
): PlatformRuleConflict | undefined {
  return conflicts.find((conflict) => conflict.level === 'exclusive' && conflict.active);
}
