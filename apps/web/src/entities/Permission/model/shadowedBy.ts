import type { PermissionRule } from '@agentdeck/contracts';
import { RANK } from './effectiveDecision.constants';
import { coversPattern } from './effectiveDecision';

export type RuleLike = Pick<PermissionRule, 'id' | 'pattern' | 'decision'>;

/**
 * Правило, из-за которого это не действует: с тем же или более широким
 * шаблоном и более сильным решением. Оба файла настроек читаются вместе —
 * Claude Code применяет оба, и запрет из settings.local.json гасит разрешение
 * из settings.json точно так же.
 */
export function shadowedBy(rule: RuleLike, rules: PermissionRule[]): PermissionRule | undefined {
  let strongest: PermissionRule | undefined;
  for (const other of rules) {
    if (other.id === rule.id) continue;
    if (RANK[other.decision] <= RANK[rule.decision]) continue;
    if (!coversPattern(other.pattern, rule.pattern)) continue;
    if (!strongest || RANK[other.decision] > RANK[strongest.decision]) strongest = other;
  }
  return strongest;
}
