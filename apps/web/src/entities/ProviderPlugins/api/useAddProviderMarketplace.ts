import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderMarketplaceActionResult } from './ProviderPluginsApi.types';
import { apiClient } from '@shared/api/client';
import { infoKey } from '../lib/infoKey';

/**
 * Рынки плагинов Codex (MAP 25): подключить, обновить снимок git, отключить.
 * Сервер зовёт `codex plugin marketplace …` — config.toml панель здесь не пишет.
 */
export function useAddProviderMarketplace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (source: string): Promise<ProviderMarketplaceActionResult> => {
      const { data } = await apiClient.post<ProviderMarketplaceActionResult>(
        '/provider-plugins/marketplaces',
        { source },
      );
      return data;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: infoKey() }),
    meta: { successMessage: 'toasts.saved' },
  });
}
