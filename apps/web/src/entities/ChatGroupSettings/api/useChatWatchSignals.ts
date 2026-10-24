import { useQuery } from '@tanstack/react-query';
import {
  chatWatchSignalsOf,
  type ChatWatchSignalsResponse,
} from '@agentdeck/contracts/group-watch';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';

/**
 * Активные сигналы сторожа одиночных чатов (`GET /api/chat/watch-signals`): один
 * список на все чаты, его читают строка чата и остров над лентой. Освежает его
 * рассылка `chat-signals` (`DOMAIN_KEYS`). Ответ разбирается на входе: битый
 * сигнал сервера другой версии выпадает поштучно, а не роняет список чатов.
 */
export function useChatWatchSignals() {
  return useQuery({
    queryKey: queryKeys.chatWatchSignals,
    queryFn: async (): Promise<ChatWatchSignalsResponse> => {
      const { data } = await apiClient.get<unknown>('/chat/watch-signals');
      return chatWatchSignalsOf(data);
    },
  });
}
