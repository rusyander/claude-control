import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { GroupPermissionLevel } from '@agentdeck/contracts/split-groups';
import { apiClient } from '@shared/api/client';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';
import { splitSettingsKeyFor } from '../lib/splitSettingsKeyFor';

export function useSaveSplitSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    /**
     * `parallel: null` — вернуть общий потолок; `permissions` не задано — строки
     * разрешений проекта не трогаем, `null` — сбросить их к общим.
     */
    mutationFn: async (body: {
      path: string;
      deliver: boolean;
      parallel: number | null;
      permissions?: Record<string, GroupPermissionLevel> | null;
    }) => {
      const { data } = await apiClient.put<SplitSettingsView>('/project-git/split-settings', body);
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(splitSettingsKeyFor(body.path), result);
    },
  });
}
