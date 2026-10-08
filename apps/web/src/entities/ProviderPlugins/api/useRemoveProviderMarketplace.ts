import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderMarketplaceActionResult } from './ProviderPluginsApi.types';
import { apiClient } from '@shared/api/client';
import { infoKey } from '../lib/infoKey';

export function useRemoveProviderMarketplace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<ProviderMarketplaceActionResult> => {
      const { data } = await apiClient.delete<ProviderMarketplaceActionResult>(
        `/provider-plugins/marketplaces/${encodeURIComponent(name)}`,
      );
      return data;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: infoKey() }),
    meta: { successMessage: 'toasts.deleted' },
  });
}
