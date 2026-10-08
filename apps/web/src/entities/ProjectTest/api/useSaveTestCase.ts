import { useViewMutation } from './useViewMutation';
import type { ProjectTestCaseInput, ProjectTestsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useSaveTestCase(path: string | undefined) {
  return useViewMutation(
    path,
    async (payload: { groupId: string; testCase: ProjectTestCaseInput }) => {
      const { data } = await apiClient.post<ProjectTestsView>('/project-tests/case', {
        path,
        ...payload,
      });
      return data;
    },
    true,
  );
}
