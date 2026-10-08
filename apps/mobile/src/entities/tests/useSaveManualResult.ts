import { useManualMutation } from './useManualMutation';
import type { ProjectTestManualResultInput, ProjectTestManualSession } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

export function useSaveManualResult(projectPath: string | undefined) {
  return useManualMutation(projectPath, (payload: ProjectTestManualResultInput) =>
    api.post<{ session: ProjectTestManualSession }>('/project-tests/manual/result', {
      path: projectPath,
      ...payload,
    }),
  );
}
