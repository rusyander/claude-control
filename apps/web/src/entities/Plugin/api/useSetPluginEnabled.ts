import { usePluginCommand } from './usePluginCommand';
import { apiClient } from '@shared/api/client';
import type { CommandResult } from '@agentdeck/contracts';

export function useSetPluginEnabled() {
  return usePluginCommand(async (input: { id: string; isEnabled: boolean }) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(input.id)}/enabled`,
      { isEnabled: input.isEnabled },
      { timeout: 120_000 },
    );
    return data;
  }, 'toasts.updated');
}
