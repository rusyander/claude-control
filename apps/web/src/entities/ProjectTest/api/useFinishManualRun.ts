import { useSessionMutation } from './useSessionMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestManualSession } from '@agentdeck/contracts';

export function useFinishManualRun(path: string | undefined) {
  return useSessionMutation(path, async (payload: { runId: string; isCancelled?: boolean }) => {
    const { data } = await apiClient.post<{ session?: ProjectTestManualSession }>(
      `/project-tests/manual/${payload.isCancelled ? 'cancel' : 'finish'}`,
      { path, runId: payload.runId },
    );
    return data.session ?? null;
  });
}
