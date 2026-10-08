import { useQuery } from '@tanstack/react-query';
import type { ChatAwaitingView } from '@agentdeck/contracts/chat-handoff';
import { apiClient } from '@shared/api/client';
import { chatKeys } from './ChatApi.constants';

/** Список разговоров. Читается из транскриптов Claude Code. */
/** Такты опроса ждущих: скрытой вкладке нечего рисовать, но звать надо. */
const AWAITING_POLL_MS = 5_000;
const AWAITING_HIDDEN_POLL_MS = 15_000;

/**
 * Кто из деревьев ждёт человека. Список чатов для этого не годится: он дорогой
 * (сканирует транскрипты) и обновляется только по событиям вкладки, а вопрос
 * группы, заведённой без вкладки, событий в ней не порождает — ни звука, ни
 * уведомления не было (находка 77 живого прогона 24.09). Ответ сервер берёт из
 * памяти, поэтому его можно спрашивать часто и из скрытой вкладки.
 */
export function useAwaitingAsks() {
  return useQuery({
    queryKey: chatKeys.awaiting,
    queryFn: async () => {
      const { data } = await apiClient.get<ChatAwaitingView>('/chat/awaiting');
      return data;
    },
    refetchInterval: () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? AWAITING_HIDDEN_POLL_MS
        : AWAITING_POLL_MS,
    refetchIntervalInBackground: true,
  });
}
