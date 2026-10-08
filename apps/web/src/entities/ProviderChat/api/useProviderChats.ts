import { useQuery } from '@tanstack/react-query';
import { providerChatKeys } from './ProviderChatApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProviderChatSummary } from '@agentdeck/contracts';

export function useProviderChats(enabled = true) {
  return useQuery({
    queryKey: providerChatKeys.list,
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderChatSummary[]>('/provider-chat/chats');
      return data;
    },
    enabled,
  });
}
