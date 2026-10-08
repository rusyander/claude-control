import { useViewMutation } from './useViewMutation';
import { api } from '../../shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

export function useStopTestRun(projectPath: string | undefined) {
  return useViewMutation(projectPath, () =>
    api.post<ProjectTestsView>('/project-tests/stop', { path: projectPath }),
  );
}
