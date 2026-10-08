import { useViewMutation } from './useViewMutation';
import type { ProjectTestCaseInput, ProjectTestsView } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

export function useSaveTestCase(projectPath: string | undefined) {
  return useViewMutation(
    projectPath,
    (payload: { groupId: string; testCase: ProjectTestCaseInput }) =>
      api.post<ProjectTestsView>('/project-tests/case', { path: projectPath, ...payload }),
  );
}
