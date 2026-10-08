import type { PermissionDecision, SettingsSource, PermissionRule } from '@agentdeck/contracts';

/** Такое же правило в том же файле: сохранять нечего, сервер ответит 409. */
export function findDuplicate(
  draft: { pattern: string; decision: PermissionDecision; source: SettingsSource },
  rules: PermissionRule[],
  exceptId?: string,
): PermissionRule | undefined {
  return rules.find(
    (rule) =>
      rule.id !== exceptId &&
      rule.pattern === draft.pattern &&
      rule.decision === draft.decision &&
      rule.source === draft.source,
  );
}
