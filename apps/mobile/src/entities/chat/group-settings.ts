import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ChatEscalationEntry,
  ChatEscalationsView,
  ChatGroupSettingsView,
} from '@agentdeck/contracts/chat-group-settings';
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
const ESCALATIONS_POLL_MS = 30_000;

export function useChatGroupSettings(
  chatId: string,
  sessionId?: string,
): UseQueryResult<ChatGroupSettingsView> {
  return useQuery({
    queryKey: ['chat', chatId, 'group-settings', sessionId ?? ''],
    queryFn: () =>
      api.get<ChatGroupSettingsView>(`/chat/${encodeURIComponent(chatId)}/group-settings`, {
        sessionId,
      }),
    enabled: Boolean(chatId),
    staleTime: 15_000,
  });
}

export function useChatEscalations(): UseQueryResult<ChatEscalationsView> {
  return useQuery({
    queryKey: ['chat-escalations'],
    queryFn: () => api.get<ChatEscalationsView>('/chat/escalations'),
    refetchInterval: ESCALATIONS_POLL_MS,
  });
}

/** Непрочитанные заметки главного чата по любому из его ключей, без повторов. */
export function unreadEscalations(
  view: ChatEscalationsView | undefined,
  keys: readonly (string | undefined)[],
): ChatEscalationEntry[] {
  if (!view) return [];
  const seen = new Set<string>();
  const out: ChatEscalationEntry[] = [];
  for (const key of keys) {
    for (const entry of (key && view.chats[key]) || []) {
      if (entry.read || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

export function useMarkEscalationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, sessionId }: { chatId: string; sessionId?: string }) =>
      api.post(
        `/chat/${encodeURIComponent(chatId)}/escalations/read` +
          (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''),
        {},
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ['chat-escalations'] }),
  });
}
