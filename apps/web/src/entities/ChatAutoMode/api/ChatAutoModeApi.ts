import { useQuery } from '@tanstack/react-query';
import type { ChatAutoModeView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { KEY } from './ChatAutoModeApi.constants';

export function useChatAutoMode(chatId: string | undefined, sessionId?: string) {
  return useQuery({
    queryKey: [...KEY, chatId ?? '', sessionId ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ChatAutoModeView>(
        `/chat/${encodeURIComponent(chatId ?? '')}/auto-mode`,
        { params: sessionId ? { sessionId } : {} },
      );
      return data;
    },
    enabled: Boolean(chatId),
  });
}
