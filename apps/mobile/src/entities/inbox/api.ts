import { useCallback } from 'react';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { localizeMediaTitle } from '@agentdeck/contracts/chat-title';
import type { ChatInbox, InboxChat } from '@agentdeck/contracts/chat-inbox';
import { api } from '../../shared/api/client';
import { useT } from '../../shared/config/i18n';

/**
 * Сводка «что идёт и кто ждёт» по всем разговорам — один запрос на экран.
 *
 * Опрос раз в пять секунд, как у `/chat/active`: своего события у чужого хода
 * нет, сервер рассказывает о нём только тому, кто спросил. Ответ отдаётся из
 * памяти реестра и кэша транскриптов, а не перечитыванием диска.
 */
export const INBOX_POLL_MS = 5_000;

export function inboxQuery(): { queryKey: unknown[]; queryFn: () => Promise<ChatInbox> } {
  return {
    // Под `chat`: конец хода на экране чата перечитывает всё `['chat']` — и
    // сводку тоже, без отдельного вызова.
    queryKey: ['chat', 'inbox'],
    queryFn: () => api.get<ChatInbox>('/chat/inbox'),
  };
}

/**
 * Чаты сводки. `select` отдаёт только чаты: время сборки ответа меняется на
 * каждом опросе, и без этого экран перерисовывался бы каждые пять секунд, даже
 * когда не изменилось ничего. Прежние данные держатся во время перезапроса и
 * при ошибке — список не мигает пустотой.
 */
export function useInbox(enabled = true): UseQueryResult<InboxChat[]> {
  const t = useT();
  const select = useCallback(
    (inbox: ChatInbox) =>
      inbox.chats.map((chat) => {
        const title = localizeMediaTitle(chat.title, (mode) => t.chat.titleWord[mode]);
        return title === chat.title ? chat : { ...chat, title };
      }),
    [t],
  );
  return useQuery({
    ...inboxQuery(),
    enabled,
    select,
    refetchInterval: INBOX_POLL_MS,
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  });
}
