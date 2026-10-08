import { useQuery } from '@tanstack/react-query';
import { ROOT_KEY } from './ProjectFileApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProjectFileContent } from '@agentdeck/contracts';

export function useProjectFile(
  path: string | undefined,
  file: string | undefined,
  chatId: string | undefined,
) {
  return useQuery({
    queryKey: [ROOT_KEY, 'content', path ?? '', file ?? '', chatId ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectFileContent>('/project-files/content', {
        params: { path, file, chatId },
      });
      return data;
    },
    enabled: Boolean(path && file),
    staleTime: 0,
  });
}
