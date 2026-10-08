import { DLP_RULE_PREFIX } from './pageTarget.constants';

export function dlpRuleAnchor(id: string): string {
  return `${DLP_RULE_PREFIX}${id}`;
}
