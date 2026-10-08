import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

export function useStopTestRun(path: string | undefined) {
  return useViewMutation(path, async () => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/stop', { path });
    return data;
  });
}
