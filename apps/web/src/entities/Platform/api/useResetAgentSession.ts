import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function resetAgentSession(input: { id: string; sessionId: string }): Promise<void> {
  await apiClient.delete(path(input.id, `/agents/sessions/${encodeURIComponent(input.sessionId)}`));
}

/** Забыть сессию у контура: после сброса агент начинает разговор с нуля. */
export function useResetAgentSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resetAgentSession,
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.platformAgentSession(variables.id, variables.sessionId),
      });
    },
  });
}
