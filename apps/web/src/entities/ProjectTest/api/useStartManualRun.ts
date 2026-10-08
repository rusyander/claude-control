import { useSessionMutation } from './useSessionMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestManualSession } from '@agentdeck/contracts';

export interface StartManualPayload {
  planId?: string;
  groupId?: string;
  caseIds?: string[];
  environmentId?: string;
}

export function useStartManualRun(path: string | undefined) {
  return useSessionMutation(path, async (payload: StartManualPayload) => {
    const { data } = await apiClient.post<{ session: ProjectTestManualSession }>(
      '/project-tests/manual/start',
      { path, ...payload },
    );
    return data.session;
  });
}
