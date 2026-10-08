import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import { useChatStatuses } from '@shared/lib/agent-runs';
import { useAwaitingAsks } from '../api/ChatApi';
import { selectAwaitingChats } from './awaiting';
import { chatKeys } from '../api/ChatApi.constants';
import { useChats } from '../api/useChats';

/**
 * Разговоры, стоящие на вопросе к человеку: транскрипт плюс вопросы деревьев из
 * памяти сервера. Чат, которого список ещё не знает (группу только что завели),
 * перечитывает список — иначе звать было бы не к кому.
 */
export function useAwaitingChats(): ChatSummary[] {
  const { data } = useChats();
  const { data: asks } = useAwaitingAsks();
  const statuses = useChatStatuses();
  const client = useQueryClient();
  const server = useMemo(
    () => (asks ? new Set(asks.chats.map((ask) => ask.chatId)) : undefined),
    [asks],
  );

  useEffect(() => {
    if (!data || !server) return;
    const known = new Set(data.map((chat) => chat.id));
    if ([...server].some((id) => !known.has(id))) {
      void client.invalidateQueries({ queryKey: chatKeys.list, exact: true });
    }
  }, [client, data, server]);

  return useMemo(() => selectAwaitingChats(data ?? [], statuses, server), [data, statuses, server]);
}
