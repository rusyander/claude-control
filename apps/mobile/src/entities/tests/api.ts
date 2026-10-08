import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectTestsView } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { KEY } from './api.constants';
const POLL_MS = 2000;

export function useProjectTests(projectPath: string | undefined): UseQueryResult<ProjectTestsView> {
  return useQuery({
    queryKey: [KEY, projectPath],
    queryFn: () => api.get<ProjectTestsView>('/project-tests', { path: projectPath }),
    enabled: Boolean(projectPath),
    staleTime: 0,
    // Прогон агента и прогон автотестов панелью идут порознь — ждём любой.
    refetchInterval: (query) =>
      query.state.data?.run?.status === 'running' || query.state.data?.e2eRun?.status === 'running'
        ? POLL_MS
        : false,
  });
}
