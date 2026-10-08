import { useQuery } from '@tanstack/react-query';
import { caseHistoryKeys } from './ProjectTestCaseHistoryApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProjectTestFlakyMarks } from '@agentdeck/contracts';

export function useTestFlakyMarks(path: string | undefined, stamp = '') {
  return useQuery({
    queryKey: caseHistoryKeys.flaky(path, stamp),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestFlakyMarks>('/project-tests/flaky', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}
