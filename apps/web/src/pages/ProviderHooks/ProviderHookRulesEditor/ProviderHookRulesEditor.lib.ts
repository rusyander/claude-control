import type { ProviderHookRule } from '@agentdeck/contracts';
import { nextRowId } from '../ProviderHooks.lib';
import type { RuleRow } from './ProviderHookRulesEditor.types';

export function toRow(rule: ProviderHookRule): RuleRow {
  return {
    id: nextRowId(),
    event: rule.event,
    matcher: rule.matcher ?? '',
    command: rule.command,
    timeout: rule.timeout === undefined ? '' : String(rule.timeout),
  };
}
