import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { OutsideMessages } from '@agentdeck/contracts/chat-inbox';
import { api } from '../../shared/api/client';

/** Как часто перечитывать статус сообщений: «ждёт шага» сменяется «передано». */
const POLL_MS = 3_000;

const key = (sessionId: string) => ['outside-messages', sessionId] as const;

/**
 * Сообщения с телефона в ход, идущий в терминале или VS Code: что ещё ждёт
 * ближайшего шага агента, а что хук панели уже отдал ему.
 */
export function useOutsideMessages(sessionId: string): UseQueryResult<OutsideMessages> {
  return useQuery({
    queryKey: key(sessionId),
    queryFn: () => api.get<OutsideMessages>('/outside/messages', { sessionId }),
    enabled: Boolean(sessionId),
    refetchInterval: POLL_MS,
  });
}

export function useSendOutsideMessage(
  sessionId: string,
): UseMutationResult<{ id: string }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (text) => api.post<{ id: string }>('/outside/messages', { sessionId, text }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(sessionId) }),
  });
}
