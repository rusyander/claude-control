import type { KimiRuleRow } from './kimiPermissionForm.types';
import type { KimiPermissionRule } from '@agentdeck/contracts';

/** Черновик для сервера: пустые шаблоны выбрасываются, порядок сохраняется. */
export const toKimiRules = (rows: readonly KimiRuleRow[]): KimiPermissionRule[] =>
  rows
    .map((row) => ({ decision: row.decision, pattern: row.pattern.trim() }))
    .filter((rule) => rule.pattern.length > 0);
