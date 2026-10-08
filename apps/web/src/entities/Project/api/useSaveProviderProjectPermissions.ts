import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderPermissionDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

export function useSaveProviderProjectPermissions(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderPermissionDraft) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/provider/permissions`,
        draft,
      );
      return data;
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectProviderPermissions(projectId),
      }),
    meta: { successMessage: 'toasts.saved' },
  });
}
