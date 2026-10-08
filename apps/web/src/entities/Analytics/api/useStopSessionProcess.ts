import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { SessionStopBody } from '@agentdeck/contracts/request-bodies';
import type { SessionStopResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { SESSION_TIMEOUT_MS } from './SessionsApi.constants';

/** Снять процесс сессии вне панели — ровно тот, что показан в окне подтверждения. */
export function useStopSessionProcess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sessionId: string;
      body: SessionStopBody;
    }): Promise<SessionStopResult> => {
      const { data } = await apiClient.post<SessionStopResult>(
        `/analytics/sessions/${encodeURIComponent(input.sessionId)}/stop`,
        input.body,
        { timeout: SESSION_TIMEOUT_MS },
      );
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['analytics'] }),
    meta: { silentError: true },
  });
}
