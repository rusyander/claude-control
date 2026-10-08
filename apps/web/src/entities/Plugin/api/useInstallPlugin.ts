import { usePluginCommand } from './usePluginCommand';
import { apiClient } from '@shared/api/client';
import type { CommandResult } from '@agentdeck/contracts';

export function useInstallPlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      '/plugins/install',
      { id },
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.pluginInstalled');
}
