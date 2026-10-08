import type { DlpRule } from '@agentdeck/contracts';
import { newRuleId } from './rules';

export function newRegexRule(name: string, label: string): DlpRule {
  return {
    id: newRuleId(),
    name,
    enabled: true,
    kind: 'regex',
    terms: [],
    pattern: '',
    action: 'mask',
    label,
  };
}
