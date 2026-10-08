import type { ResourceKind } from './ResourceApi.types';
import { useResourceMutation } from './useResourceMutation';
import { apiClient } from '@shared/api/client';

export function useDeleteResourceFile(kind: ResourceKind, id: string) {
  return useResourceMutation(
    kind,
    id,
    async (file: string) => {
      await apiClient.delete(`/resources/${kind}/${encodeURIComponent(id)}/file`, {
        params: { file },
      });
    },
    'toasts.deleted',
  );
}
