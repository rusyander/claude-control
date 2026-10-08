import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderExtensionActionResult } from './ProviderPluginsApi.types';
import { apiClient } from '@shared/api/client';
import { infoKey } from '../lib/infoKey';

export function useUninstallProviderExtension() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<ProviderExtensionActionResult> => {
      const { data } = await apiClient.delete<ProviderExtensionActionResult>(
        `/provider-plugins/installed/${encodeURIComponent(name)}`,
      );
      return data;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: infoKey() }),
    meta: { successMessage: 'toasts.pluginRemoved' },
  });
}
