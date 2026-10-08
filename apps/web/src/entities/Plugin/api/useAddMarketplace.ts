import { usePluginCommand } from './usePluginCommand';
import { apiClient } from '@shared/api/client';
import type { CommandResult } from '@agentdeck/contracts';

export function useAddMarketplace() {
  return usePluginCommand(async (source: string) => {
    const { data } = await apiClient.post<CommandResult>(
      '/plugins/marketplaces',
      { source },
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.marketplaceAdded');
}
