import { useViewMutation } from './useViewMutation';
import { api } from '../../shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

export function useRemoveTestCase(projectPath: string | undefined) {
  return useViewMutation(projectPath, (payload: { groupId: string; caseId: string }) =>
    api.deleteBy<ProjectTestsView>('/project-tests/case', { path: projectPath, ...payload }),
  );
}
