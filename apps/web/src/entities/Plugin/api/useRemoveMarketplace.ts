import { usePluginCommand } from './usePluginCommand';
import { apiClient } from '@shared/api/client';
import type { CommandResult } from '@agentdeck/contracts';

export function useRemoveMarketplace() {
  return usePluginCommand(async (name: string) => {
    const { data } = await apiClient.delete<CommandResult>(
      `/plugins/marketplaces/${encodeURIComponent(name)}`,
      { timeout: 120_000 },
    );
    return data;
  }, 'toasts.marketplaceRemoved');
}
