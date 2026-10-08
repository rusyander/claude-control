import type { RuleFormatTraits } from './ruleLabels.types';

/** Правило подключается всегда: у Cursor — флагом, у Qwen — отсутствием шаблонов. */
export function appliesAlways(
  traits: RuleFormatTraits,
  rule: { alwaysApply?: boolean; globs?: string },
): boolean {
  return traits.alwaysApply ? Boolean(rule.alwaysApply) : !rule.globs;
}
