import { useViewMutation } from './useViewMutation';
import type { ProjectTestSharedStep, ProjectTestsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useSaveSharedStep(path: string | undefined) {
  return useViewMutation(path, async (step: ProjectTestSharedStep) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/shared-step', {
      path,
      step,
    });
    return data;
  });
}
