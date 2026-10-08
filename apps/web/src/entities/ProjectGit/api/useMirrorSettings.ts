import { useQuery } from '@tanstack/react-query';
import { mirrorSettingsKeyFor } from '../lib/mirrorSettingsKeyFor';
import { apiClient } from '@shared/api/client';
import type { WorktreeMirrorSettings } from '@agentdeck/contracts';

/** Что человек дописал к встроенному списку зеркала на этом проекте. */
export function useMirrorSettings(path: string | undefined) {
  return useQuery({
    queryKey: mirrorSettingsKeyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<WorktreeMirrorSettings>('/project-git/mirror-settings', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}
