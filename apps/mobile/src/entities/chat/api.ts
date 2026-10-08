import { useCallback } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { useLocalTitle } from './useLocalTitle';
import { STALE_MS } from './api.constants';

/** Разговоры, которые ждут ответа: по ним ставится жёлтая точка в списках. */
export type AwaitingChats = Record<string, boolean>;

export function useChats(): UseQueryResult<ChatSummary[]> {
  const localTitle = useLocalTitle();
  const select = useCallback((chats: ChatSummary[]) => chats.map(localTitle), [localTitle]);
  return useQuery({
    queryKey: ['chats'],
    queryFn: () => api.get<ChatSummary[]>('/chats'),
    staleTime: STALE_MS,
    select,
  });
}
