import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { OutsideRelayState } from '@agentdeck/contracts/chat-inbox';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

const KEY = ['outside-relay'] as const;

/**
 * Сессии вне панели — на телефон (вопросы, права, сообщения посреди хода):
 * включено ли и стоят ли хуки панели в настройках Claude Code. Хуки ставит
 * человек на компьютере, поэтому опрос нужен — «не установлены» сменится само,
 * когда их добавят в «Хуках».
 */
export function useOutsideRelay(): UseQueryResult<OutsideRelayState> {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<OutsideRelayState>('/outside/relay'),
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: isConfigured(),
  });
}

export function useOutsideRelayToggle(): UseMutationResult<OutsideRelayState, Error, boolean> {
  const queryClient = useQueryClient();
  return useMutation<OutsideRelayState, Error, boolean>({
    mutationFn: (enabled) => api.patch<OutsideRelayState>('/outside/relay', { enabled }),
    onSuccess: (state) => queryClient.setQueryData(KEY, state),
  });
}
