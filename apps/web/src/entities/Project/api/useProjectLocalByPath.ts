import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { ProjectLocalConfig } from '@agentdeck/contracts';

export function useProjectLocalByPath(path: string) {
  return useQuery({
    queryKey: queryKeys.projectLocalByPath(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectLocalConfig>('/projects/local', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}
