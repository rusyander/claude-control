import type { DlpRule } from '@agentdeck/contracts';

export function replaceRule(rules: DlpRule[], next: DlpRule): DlpRule[] {
  return rules.map((rule) => (rule.id === next.id ? next : rule));
}
