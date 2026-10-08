import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestReport } from '@agentdeck/contracts';

export function useTestReport(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.report(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestReport>('/project-tests/report', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
