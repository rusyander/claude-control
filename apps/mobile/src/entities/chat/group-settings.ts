import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChatGroupSettingsView } from '@agentdeck/contracts/chat-group-settings';
import { api } from '../../shared/api/client';

export function useChatGroupSettings(
  chatId: string,
  sessionId?: string,
): UseQueryResult<ChatGroupSettingsView> {
  return useQuery({
    queryKey: ['chat', chatId, 'group-settings', sessionId ?? ''],
    queryFn: () =>
      api.get<ChatGroupSettingsView>(`/chat/${encodeURIComponent(chatId)}/group-settings`, {
        sessionId,
      }),
    enabled: Boolean(chatId),
    staleTime: 15_000,
  });
}
