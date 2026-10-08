import type { UseQueryResult } from '@tanstack/react-query';
import type { ChatMessagesPage } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { chatMessagesQuery } from './chatMessagesQuery';
import { STALE_MS } from './api.constants';

export function useChatMessages(chatId: string, limit = 60): UseQueryResult<ChatMessagesPage> {
  return useQuery({
    ...chatMessagesQuery(chatId, limit),
    enabled: Boolean(chatId) && !chatId.startsWith('new-'),
    staleTime: STALE_MS,
  });
}
