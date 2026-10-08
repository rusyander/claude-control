import type { UseQueryResult } from '@tanstack/react-query';
import type { ChatProgress } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { STALE_MS } from './api.constants';

/** План агента и дерево субагентов — read-only, из транскрипта. */
export function useChatProgress(chatId: string, isRunning: boolean): UseQueryResult<ChatProgress> {
  return useQuery({
    queryKey: ['chat', chatId, 'progress'],
    queryFn: () => api.get<ChatProgress>(`/chat/${encodeURIComponent(chatId)}/progress`),
    enabled: Boolean(chatId) && !chatId.startsWith('new-'),
    // Пока агент работает, план меняется — обновляем сами; после завершения он
    // застывает, и опрашивать его дальше значит будить сеть впустую.
    refetchInterval: isRunning ? 5_000 : false,
    staleTime: STALE_MS,
  });
}
