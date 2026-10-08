import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderKeyResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Задать ключ провайдера. Инвалидирует список ключей и резолв раннера. */
export function useSaveProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; key: string }): Promise<ProviderKeyResult> => {
      const { data } = await apiClient.put<ProviderKeyResult>(
        `/provider-keys/${encodeURIComponent(input.providerId)}`,
        { key: input.key },
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerRunner });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
