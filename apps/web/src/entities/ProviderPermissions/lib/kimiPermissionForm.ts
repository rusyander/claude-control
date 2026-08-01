import type { KimiDecision, KimiPermissionRule } from '@claude-control/contracts';

/** Строка формы: `id` нужен, чтобы строки не «прыгали» при вводе. */
export interface KimiRuleRow {
  id: number;
  decision: KimiDecision;
  pattern: string;
}

export const toKimiRuleRows = (rules: readonly KimiPermissionRule[]): KimiRuleRow[] =>
  rules.map((rule, index) => ({ id: index, decision: rule.decision, pattern: rule.pattern }));

/** Черновик для сервера: пустые шаблоны выбрасываются, порядок сохраняется. */
export const toKimiRules = (rows: readonly KimiRuleRow[]): KimiPermissionRule[] =>
  rows
    .map((row) => ({ decision: row.decision, pattern: row.pattern.trim() }))
    .filter((rule) => rule.pattern.length > 0);

/** Нормализованный слепок правил — по нему считается «есть правки». Порядок значим. */
export const stableKimiRules = (rules: readonly KimiPermissionRule[]): string =>
  JSON.stringify(rules.map((rule) => [rule.decision, rule.pattern]));
