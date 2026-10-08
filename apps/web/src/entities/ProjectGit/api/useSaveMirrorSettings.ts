import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { mirrorSettingsKeyFor } from '../lib/mirrorSettingsKeyFor';

export function useSaveMirrorSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: { path: string } & WorktreeMirrorSettings) => {
      const { data } = await apiClient.put<WorktreeMirrorSettings>(
        '/project-git/mirror-settings',
        body,
      );
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(mirrorSettingsKeyFor(body.path), result);
    },
  });
}
