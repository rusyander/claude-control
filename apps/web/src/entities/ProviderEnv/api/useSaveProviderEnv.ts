import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderEnvVar, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Bulk-сохранение полного набора переменных. Инвалидирует раздел + сводку. */
export function useSaveProviderEnv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: ProviderEnvVar[]): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>('/provider-env', { vars });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerEnv });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
