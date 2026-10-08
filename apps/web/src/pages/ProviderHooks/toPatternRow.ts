import type { ProviderHookPatternGroup } from '@agentdeck/contracts';
import type { PatternRow } from './ProviderHooks.types';
import { toActionRow } from './toActionRow';
import { nextRowId } from './ProviderHooks.lib';

export function toPatternRow(group: ProviderHookPatternGroup): PatternRow {
  return {
    id: nextRowId(),
    pattern: group.pattern,
    actions: group.actions.map(toActionRow),
  };
}
