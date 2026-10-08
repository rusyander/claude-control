import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { RUNS_KEY } from './api.constants';
import { api } from '../../shared/api/client';

/** История прогонов: список записей `runs/*.run.json` от новых к старым. */
export function useTestRuns(
  projectPath: string | undefined,
  limit = 50,
): UseQueryResult<ProjectTestRunRecord[]> {
  return useQuery({
    queryKey: [RUNS_KEY, projectPath, limit],
    queryFn: async () => {
      const body = await api.get<{ runs: ProjectTestRunRecord[] }>('/project-tests/runs', {
        path: projectPath,
        limit,
      });
      return body.runs;
    },
    enabled: Boolean(projectPath),
  });
}
