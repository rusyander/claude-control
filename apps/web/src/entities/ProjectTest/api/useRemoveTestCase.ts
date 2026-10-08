import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

export function useRemoveTestCase(path: string | undefined) {
  return useViewMutation(path, async (payload: { groupId: string; caseId: string }) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/case', {
      params: { path, ...payload },
    });
    return data;
  });
}
