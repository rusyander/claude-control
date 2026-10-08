import { usePluginCommand } from './usePluginCommand';
import { apiClient } from '@shared/api/client';
import type { CommandResult } from '@agentdeck/contracts';

export function useUninstallPlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(id)}/uninstall`,
      {},
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.pluginRemoved');
}
