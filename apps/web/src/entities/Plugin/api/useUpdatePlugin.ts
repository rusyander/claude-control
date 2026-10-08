import { usePluginCommand } from './usePluginCommand';
import { apiClient } from '@shared/api/client';
import type { CommandResult } from '@agentdeck/contracts';

export function useUpdatePlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(id)}/update`,
      {},
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.pluginUpdated');
}
