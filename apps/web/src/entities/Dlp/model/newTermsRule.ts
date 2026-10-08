import type { DlpRule } from '@agentdeck/contracts';
import { newRuleId } from './rules';

export function newTermsRule(name: string, label: string): DlpRule {
  return {
    id: newRuleId(),
    name,
    enabled: true,
    kind: 'terms',
    terms: [],
    pattern: '',
    action: 'mask',
    label,
  };
}
