import type { Hook, HookDraft } from '@claude-control/contracts';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const hookApi = createEntityApi<Hook, HookDraft>({
  resource: 'hooks',
  listKey: queryKeys.hooks,
  kind: 'hook',
});
