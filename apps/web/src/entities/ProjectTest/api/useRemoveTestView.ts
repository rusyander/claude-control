import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

export function useRemoveTestView(path: string | undefined) {
  return useViewMutation(path, async (id: string) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/view', {
      params: { path, id },
    });
    return data;
  });
}
