import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderKeyResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Очистить ключ провайдера. Инвалидирует список ключей и резолв раннера. */
export function useClearProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string): Promise<ProviderKeyResult> => {
      const { data } = await apiClient.delete<ProviderKeyResult>(
        `/provider-keys/${encodeURIComponent(providerId)}`,
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerRunner });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}
