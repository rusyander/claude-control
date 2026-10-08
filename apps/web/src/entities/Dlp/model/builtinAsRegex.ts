import type { DlpRule } from '@agentdeck/contracts';

/**
 * Встроенный образец → своё выражение с тем же текстом. Правило остаётся тем же
 * (id, название, действие, метка, выключатель) — меняется только то, чем оно
 * ищет, и дальше его выражение правится как любое своё.
 */
export function builtinAsRegex(rule: DlpRule, pattern: string): DlpRule {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    kind: 'regex',
    terms: [],
    pattern,
    action: rule.action,
    label: rule.label,
  };
}
