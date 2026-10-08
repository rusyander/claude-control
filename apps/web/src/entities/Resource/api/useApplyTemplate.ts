import type { ResourceKind } from './ResourceApi.types';
import { useResourceMutation } from './useResourceMutation';
import { apiClient } from '@shared/api/client';

export function useApplyTemplate(kind: ResourceKind, id: string) {
  return useResourceMutation(
    kind,
    id,
    async (templateId: string) => {
      await apiClient.post(`/resources/${kind}/${encodeURIComponent(id)}/apply-template`, {
        templateId,
      });
    },
    'toasts.templateApplied',
  );
}
