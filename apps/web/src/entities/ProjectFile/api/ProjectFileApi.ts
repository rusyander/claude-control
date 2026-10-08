import { useQuery } from '@tanstack/react-query';
import type { ProjectFileTree } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { ROOT_KEY } from './ProjectFileApi.constants';

export function useProjectTree(path: string | undefined, dir: string) {
  return useQuery({
    queryKey: [ROOT_KEY, 'tree', path ?? '', dir],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectFileTree>('/project-files/tree', {
        params: { path, dir },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}
