import type { UseQueryResult } from '@tanstack/react-query';
import type { ChatEscalationsView } from '@agentdeck/contracts/chat-group-settings';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

/**
 * Группа и автономность чата и заметки главному чату — глазами телефона.
 *
 * Меняются настройки в меню чата панели: здесь они только видны, иначе на
 * телефоне пришлось бы повторить весь выбор групп вместе с проектными. Заметки
 * телефон читает и может отметить прочитанными — это то, ради чего на него
 * смотрят, пока группы идут сами.
 */

/** Рассылки изменений у телефона нет — заметки освежаются сами, раз в полминуты. */
export const ESCALATIONS_POLL_MS = 30_000;

export function useChatEscalations(): UseQueryResult<ChatEscalationsView> {
  return useQuery({
    queryKey: ['chat-escalations'],
    queryFn: () => api.get<ChatEscalationsView>('/chat/escalations'),
    refetchInterval: ESCALATIONS_POLL_MS,
  });
}
