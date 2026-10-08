import { useTranslation } from 'react-i18next';
import { useCallback } from 'react';
import type { ChatSummary } from '@agentdeck/contracts';
import { localizeMediaTitle } from '@agentdeck/contracts/chat-title';
import { useQuery } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';
import { apiClient } from '@shared/api/client';

export function useChats() {
  const { t } = useTranslation();
  // Слово режима в названии («Картинка: …») сервер пишет по-русски — одно
  // название на все клиенты; интерфейс ставит своё (`localizeMediaTitle`).
  const select = useCallback(
    (chats: ChatSummary[]): ChatSummary[] =>
      chats.map((chat) => {
        const title = localizeMediaTitle(chat.title, (mode) => t(`chat.mode.request.${mode}`));
        return title === chat.title ? chat : { ...chat, title };
      }),
    [t],
  );
  return useQuery({
    queryKey: chatKeys.list,
    queryFn: async () => {
      const { data } = await apiClient.get<ChatSummary[]>('/chats', { timeout: 120_000 });
      return data;
    },
    select,
  });
}
