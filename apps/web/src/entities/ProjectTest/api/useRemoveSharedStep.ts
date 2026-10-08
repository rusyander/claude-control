import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

export function useRemoveSharedStep(path: string | undefined) {
  return useViewMutation(path, async (id: string) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/shared-step', {
      params: { path, id },
    });
    return data;
  });
}
