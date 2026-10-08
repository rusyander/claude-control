import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderExtensionActionResult } from './ProviderPluginsApi.types';
import { apiClient } from '@shared/api/client';
import { infoKey } from '../lib/infoKey';

export function useSetProviderExtensionEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      name,
      enabled,
    }: {
      name: string;
      enabled: boolean;
    }): Promise<ProviderExtensionActionResult> => {
      const { data } = await apiClient.post<ProviderExtensionActionResult>(
        `/provider-plugins/installed/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`,
      );
      return data;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: infoKey() }),
    meta: { successMessage: 'toasts.updated' },
  });
}
