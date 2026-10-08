import type { PatternRow } from './ProviderHooks.types';
import type { ProviderHookPatternGroup, ProviderHookAction } from '@agentdeck/contracts';
import { toActionDraft } from './toActionDraft';

export function toPatternDraft(row: PatternRow): ProviderHookPatternGroup | undefined {
  const pattern = row.pattern.trim();
  if (!pattern) return undefined;
  const actions = row.actions
    .map(toActionDraft)
    .filter((action): action is ProviderHookAction => Boolean(action));
  return actions.length > 0 ? { pattern, actions } : undefined;
}
