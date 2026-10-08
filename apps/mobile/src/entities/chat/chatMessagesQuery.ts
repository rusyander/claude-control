import type { ChatMessagesPage } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Лента разговора. Отдаётся окнами с конца: транскрипт длинного разговора
 * весит мегабайты, и тянуть его целиком на телефон незачем.
 */
export function chatMessagesQuery(
  chatId: string,
  limit = 60,
): { queryKey: unknown[]; queryFn: () => Promise<ChatMessagesPage> } {
  return {
    queryKey: ['chat', chatId, 'messages', limit],
    queryFn: () =>
      api.get<ChatMessagesPage>(`/chats/${encodeURIComponent(chatId)}/messages`, { limit }),
  };
}
