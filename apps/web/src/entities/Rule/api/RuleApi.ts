import type { Rule, RuleDraft } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { createEntityApi } from '../../../shared/api/createEntityApi';

export const ruleApi = createEntityApi<Rule, RuleDraft>({
  resource: 'rules',
  listKey: queryKeys.rules,
  kind: 'rule',
});
