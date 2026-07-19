import type { Rule, RuleDraft } from '@claude-control/contracts';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const ruleApi = createEntityApi<Rule, RuleDraft>({
  resource: 'rules',
  listKey: queryKeys.rules,
  kind: 'rule',
});
