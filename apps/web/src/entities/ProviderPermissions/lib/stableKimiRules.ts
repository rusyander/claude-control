import type { KimiPermissionRule } from '@agentdeck/contracts';

/** Нормализованный слепок правил — по нему считается «есть правки». Порядок значим. */
export const stableKimiRules = (rules: readonly KimiPermissionRule[]): string =>
  JSON.stringify(rules.map((rule) => [rule.decision, rule.pattern]));
