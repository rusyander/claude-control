import type { UseQueryResult } from '@tanstack/react-query';
import type { ProviderChatSummary } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { foreignKeys, LIST_POLL_MS } from './api.constants';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/** Разговоры активного CLI. У Claude их нет — у него свой чат. */
export function useForeignChats(
  providerId: string | undefined,
): UseQueryResult<ProviderChatSummary[]> {
  return useQuery({
    queryKey: foreignKeys.list(providerId ?? ''),
    queryFn: () => api.get<ProviderChatSummary[]>('/provider-chat/chats'),
    enabled: isConfigured() && Boolean(providerId) && providerId !== 'claude',
    refetchInterval: LIST_POLL_MS,
  });
}
