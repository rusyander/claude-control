import { useManualMutation } from './useManualMutation';
import { api } from '../../shared/api/client';
import type { ProjectTestManualSession } from '@agentdeck/contracts';

export interface StartManualRun {
  planId?: string;
  groupId?: string;
  caseIds?: string[];
  environmentId?: string;
}

export function useStartManualRun(projectPath: string | undefined) {
  return useManualMutation(projectPath, (payload: StartManualRun) =>
    api.post<{ session: ProjectTestManualSession }>('/project-tests/manual/start', {
      path: projectPath,
      ...payload,
    }),
  );
}
