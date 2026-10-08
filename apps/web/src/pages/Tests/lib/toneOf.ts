import type { ProjectTestCoverageItem } from '@agentdeck/contracts';

/** Цвет строки: не покрыто — красное, красные кейсы — предупреждение, иначе зелень. */
export function toneOf(item: ProjectTestCoverageItem): 'danger' | 'warning' | 'success' {
  if (item.cases.length === 0) return 'danger';
  if (item.counts.failed > 0 || item.counts.blocked > 0) return 'warning';
  return 'success';
}
