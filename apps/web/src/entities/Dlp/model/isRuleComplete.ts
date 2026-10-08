import type { DlpRule } from '@agentdeck/contracts';

/**
 * Готово ли правило к работе. Незаполненное правило не «почти работает», а не
 * работает вовсе — и раздел обязан сказать это до того, как прокси поднимут.
 */
export function isRuleComplete(rule: DlpRule): boolean {
  if (rule.kind === 'builtin') return Boolean(rule.builtin);
  if (rule.kind === 'terms') return rule.terms.some((term) => term.trim().length > 0);
  return rule.pattern.trim().length > 0;
}
