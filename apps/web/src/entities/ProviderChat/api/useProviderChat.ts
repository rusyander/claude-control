import { useQuery } from '@tanstack/react-query';
import { providerChatKeys } from './ProviderChatApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProviderChatDetail } from '@agentdeck/contracts';

export function useProviderChat(chatId: string | undefined) {
  return useQuery({
    queryKey: providerChatKeys.detail(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderChatDetail>(`/provider-chat/chats/${chatId}`);
      return data;
    },
    enabled: Boolean(chatId),
  });
}
