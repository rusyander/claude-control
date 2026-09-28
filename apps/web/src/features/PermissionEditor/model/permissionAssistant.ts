import type { PermissionDecision } from '@agentdeck/contracts';
import type { AssistantSpec } from '@shared/lib/assistant-fields';

const DECISION_LABEL: Record<PermissionDecision, string> = {
  allow: 'do it without asking',
  ask: 'ask first',
  deny: 'forbid',
};

/** Поля правила доступа: шаблон и одно решение из трёх. */
export function permissionAssistantSpec(decisions: readonly PermissionDecision[]) {
  return {
    pattern: {
      type: 'text',
      hint:
        'Permission rule: a whole tool name (Bash, Read, WebFetch) or a narrowed one — ' +
        'Bash(git push:*), mcp__server__tool',
    },
    decision: {
      type: 'choice',
      hint: 'Decision',
      options: decisions.map((value) => ({ value, label: DECISION_LABEL[value] })),
    },
  } satisfies AssistantSpec;
}
