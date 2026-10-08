import { useMemo } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { useInbox } from '../../entities/inbox/api';
import { useRuns } from '../../shared/lib/runs';
import { withLiveAsks } from '../../entities/inbox/withLiveAsks';

/**
 * Сводка «что идёт и кто ждёт» глазами телефона: ответ сервера плюс вопросы
 * идущих ходов из их потоков (`withLiveAsks`). Одна точка для главной, вкладки
 * с числом и экрана чата — иначе они разошлись бы в ответе на «ждут ли меня».
 */
export function useInboxChats(enabled = true): UseQueryResult<InboxChat[]> {
  const inbox = useInbox(enabled);
  const runs = useRuns();
  const data = useMemo(
    () => (inbox.data ? withLiveAsks(inbox.data, runs) : undefined),
    [inbox.data, runs],
  );
  return { ...inbox, data } as UseQueryResult<InboxChat[]>;
}
