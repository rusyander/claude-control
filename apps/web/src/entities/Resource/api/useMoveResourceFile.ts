import type { ResourceKind } from './ResourceApi.types';
import { useResourceMutation } from './useResourceMutation';
import { apiClient } from '@shared/api/client';

export function useMoveResourceFile(kind: ResourceKind, id: string) {
  return useResourceMutation(
    kind,
    id,
    async (input: { from: string; to: string }) => {
      await apiClient.post(`/resources/${kind}/${encodeURIComponent(id)}/move`, input);
    },
    'toasts.moved',
  );
}
