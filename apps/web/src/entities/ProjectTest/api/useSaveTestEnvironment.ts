import { useViewMutation } from './useViewMutation';
import type { ProjectTestEnvironment, ProjectTestsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useSaveTestEnvironment(path: string | undefined) {
  return useViewMutation(path, async (environment: ProjectTestEnvironment) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/environment', {
      path,
      environment,
    });
    return data;
  });
}
