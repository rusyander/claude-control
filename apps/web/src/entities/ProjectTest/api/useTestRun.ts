import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';

export function useTestRun(path: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: testKeys.run(path, id),
    queryFn: async () => {
      const { data } = await apiClient.get<{ run: ProjectTestRunRecord }>('/project-tests/run', {
        params: { path, id },
      });
      return data.run;
    },
    enabled: Boolean(path) && Boolean(id),
  });
}
