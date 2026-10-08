import type { DlpRule } from '@agentdeck/contracts';

export function removeRule(rules: DlpRule[], id: string): DlpRule[] {
  return rules.filter((rule) => rule.id !== id);
}
