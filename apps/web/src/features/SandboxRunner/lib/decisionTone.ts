import type { HookDecision } from '@entities/Sandbox';

/** Тон бейджа решения хука: отказ и сбой одинаково тревожны, «спросить» — предупреждение. */
export function toneOf(decision: HookDecision): 'danger' | 'warning' | 'neutral' {
  if (decision === 'block' || decision === 'error') return 'danger';
  if (decision === 'ask') return 'warning';
  return 'neutral';
}
