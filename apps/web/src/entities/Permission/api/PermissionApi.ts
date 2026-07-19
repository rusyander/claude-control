import type { PermissionRule, PermissionDraft } from '@agentdeck/contracts';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const permissionApi = createEntityApi<PermissionRule, PermissionDraft>({
  resource: 'permissions',
  listKey: queryKeys.permissions,
  kind: 'permission',
});
