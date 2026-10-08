import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';
import { apiClient } from '@shared/api/client';
import type { ChatMessagesPage } from '@agentdeck/contracts';

/** Размер окна ленты и шаг подгрузки более ранних сообщений. */
export const CHAT_PAGE_SIZE = 400;

/**
 * Лента переписки окном. По умолчанию — последние `CHAT_PAGE_SIZE` сообщений;
 * увеличивая `limit` кнопкой «Загрузить ещё», подтягиваем более ранние. Прежнее
 * окно держим на экране, пока грузится расширенное, — лента не мигает пустотой.
 */
export function useChatMessages(chatId: string | undefined, limit = CHAT_PAGE_SIZE) {
  return useQuery({
    queryKey: [...chatKeys.messages(chatId ?? ''), limit] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<ChatMessagesPage>(`/chats/${chatId}/messages`, {
        params: { limit },
        timeout: 120_000,
      });
      return data;
    },
    enabled: Boolean(chatId),
    // Прежнее окно держим, только пока разговор ТОТ ЖЕ. Ушли в новый черновик —
    // `chatId` пуст, и лента обязана опустеть: иначе поверх чистого черновика
    // висят сообщения прошлого разговора и «Новый чат» выглядит несработавшим.
    placeholderData: chatId ? keepPreviousData : undefined,
  });
}
