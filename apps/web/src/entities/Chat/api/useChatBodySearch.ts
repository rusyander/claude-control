import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';
import { apiClient } from '@shared/api/client';
import type { ChatSearchResponse } from '@agentdeck/contracts';

/** Ниже этого порога поиск по телу не запускаем — совпадает с порогом на сервере. */
export const MIN_CHAT_SEARCH_LENGTH = 2;

/**
 * Полнотекстовый поиск по телу переписки. Запрос уходит на сервер, который
 * сканирует транскрипты и возвращает разговоры со сниппетом вокруг совпадения.
 * Слишком короткий запрос на сервер не шлём — он всё равно вернул бы пусто.
 */
export function useChatBodySearch(query: string) {
  const normalized = query.trim();
  const enabled = normalized.length >= MIN_CHAT_SEARCH_LENGTH;

  return useQuery({
    queryKey: chatKeys.search(normalized),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatSearchResponse>('/chat/search', {
        params: { q: normalized },
        timeout: 120_000,
      });
      return data;
    },
    enabled,
    // Прежние совпадения держим на экране, пока грузятся новые — список не мигает
    // пустотой на каждый набранный символ. Но только пока запрос действует:
    // у выключенного (поле стёрли) прежний ответ выдавался бы за ответ на
    // пустой запрос, и после «кактуса» в списке оставался один разговор.
    placeholderData: enabled ? keepPreviousData : undefined,
  });
}
