import { useSessionMutation } from './useSessionMutation';
import type { ProjectTestManualResultInput, ProjectTestManualSession } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useSaveManualResult(path: string | undefined) {
  return useSessionMutation(path, async (payload: ProjectTestManualResultInput) => {
    const { data } = await apiClient.post<{ session: ProjectTestManualSession }>(
      '/project-tests/manual/result',
      { path, ...payload },
    );
    return data.session;
  });
}
