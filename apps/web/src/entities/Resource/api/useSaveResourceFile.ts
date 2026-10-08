import type { ResourceKind } from './ResourceApi.types';
import { useResourceMutation } from './useResourceMutation';
import { apiClient } from '@shared/api/client';

export function useSaveResourceFile(kind: ResourceKind, id: string) {
  return useResourceMutation(
    kind,
    id,
    async (input: { file: string; content: string }) => {
      await apiClient.put(`/resources/${kind}/${encodeURIComponent(id)}/file`, input);
    },
    'toasts.saved',
  );
}
