import type { PermissionRule } from '@agentdeck/contracts';
import { RANK } from './effectiveDecision.constants';
import { coversPattern } from './effectiveDecision';

/**
 * Действующее правило для шаблона: самое сильное из накрывающих его. При
 * равной силе точное совпадение важнее широкого — его и предложим править.
 */
export function effectiveRuleFor(
  pattern: string,
  rules: PermissionRule[],
): PermissionRule | undefined {
  let best: PermissionRule | undefined;
  for (const rule of rules) {
    if (!coversPattern(rule.pattern, pattern)) continue;
    const stronger = !best || RANK[rule.decision] > RANK[best.decision];
    const sameButExact =
      best !== undefined &&
      RANK[rule.decision] === RANK[best.decision] &&
      rule.pattern === pattern &&
      best.pattern !== pattern;
    if (stronger || sameButExact) best = rule;
  }
  return best;
}
