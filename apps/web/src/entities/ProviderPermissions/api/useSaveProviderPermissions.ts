import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderPermissionDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Сохранить оба ключа прав. Инвалидирует раздел + сводку. */
export function useSaveProviderPermissions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderPermissionDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>('/provider-permissions', draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerPermissions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
