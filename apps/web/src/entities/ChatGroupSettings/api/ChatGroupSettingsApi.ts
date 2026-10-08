import { useQuery } from '@tanstack/react-query';
import type { ChatGroupSettingsView } from '@agentdeck/contracts/chat-group-settings';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { params } from '../lib/params';

export function useChatGroupSettings(chatId: string | undefined, sessionId?: string) {
  return useQuery({
    queryKey: queryKeys.chatGroupSettings(chatId ?? '', sessionId),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatGroupSettingsView>(
        `/chat/${encodeURIComponent(chatId ?? '')}/group-settings`,
        { params: params(sessionId) },
      );
      return data;
    },
    enabled: Boolean(chatId),
  });
}
