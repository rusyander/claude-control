import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderMarketplaceActionResult } from './ProviderPluginsApi.types';
import { apiClient } from '@shared/api/client';
import { infoKey } from '../lib/infoKey';

export function useUpgradeProviderMarketplace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<ProviderMarketplaceActionResult> => {
      const { data } = await apiClient.post<ProviderMarketplaceActionResult>(
        `/provider-plugins/marketplaces/${encodeURIComponent(name)}/upgrade`,
      );
      return data;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: infoKey() }),
    meta: { successMessage: 'toasts.updated' },
  });
}
