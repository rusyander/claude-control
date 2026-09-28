import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChatEscalationEntry,
  ChatEscalationsView,
  ChatGroupSettingsView,
  StoredChatGroupSettings,
} from '@agentdeck/contracts/chat-group-settings';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Группа и автономность ЧАТА и заметки главному чату дерева — сторона клиента.
 *
 * Правда — на сервере: прогоны детей разделения заводит панель без вкладки, и
 * выбор в браузере до них не доехал бы. Ключ разговора — оба написания
 * (`new-…` вкладки и `sessionId`), сервер сводит их к одной записи.
 */

const params = (sessionId?: string) => (sessionId ? { sessionId } : {});

export function useChatGroupSettings(chatId: string | undefined, sessionId?: string) {
  return useQuery({
    queryKey: queryKeys.chatGroupSettings(chatId ?? '', sessionId),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatGroupSettingsView>(
        `/chat/${encodeURIComponent(chatId ?? '')}/group-settings`,
        { params: params(sessionId) },
      );
      return data;
    },
    enabled: Boolean(chatId),
  });
}

/**
 * Своё у чата из действующего вида: унаследованное поле своим не считается —
 * иначе первый же щелчок у ребёнка «приклеил» бы родительское значение, и
 * правка у родителя до ребёнка больше не доходила бы.
 */
export function ownSettings(view: ChatGroupSettingsView | undefined): StoredChatGroupSettings {
  if (!view) return {};
  return {
    ...(view.groupChoiceInherited ? {} : { groupChoice: view.groupChoice }),
    ...(view.autonomousInherited ? {} : { autonomous: view.autonomous }),
  };
}

export function useSetChatGroupSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      chatId: string;
      sessionId?: string;
      /**
       * Проект вкладки — подсказка серверу для черновика без транскрипта: по ней
       * он отказывает в неактивной стороне пары (F-107). Транскрипт сильнее.
       */
      projectPath?: string;
      settings: StoredChatGroupSettings;
    }) => {
      const { data } = await apiClient.put<ChatGroupSettingsView>(
        `/chat/${encodeURIComponent(input.chatId)}/group-settings`,
        input.settings,
        {
          params: {
            ...params(input.sessionId),
            ...(input.projectPath ? { projectPath: input.projectPath } : {}),
          },
        },
      );
      return data;
    },
    onSuccess: (view, input) => {
      client.setQueryData(queryKeys.chatGroupSettings(input.chatId, input.sessionId), view);
      // Дети наследуют — их вид тоже мог смениться.
      void client.invalidateQueries({ queryKey: ['chat-group-settings'] });
    },
  });
}

export function useChatEscalations() {
  return useQuery({
    queryKey: queryKeys.chatEscalations,
    queryFn: async () => {
      const { data } = await apiClient.get<ChatEscalationsView>('/chat/escalations');
      return data;
    },
  });
}

/** Заметки главного чата по любому из его ключей. */
export function escalationsOf(
  view: ChatEscalationsView | undefined,
  keys: readonly (string | undefined)[],
): ChatEscalationEntry[] {
  if (!view) return [];
  const seen = new Set<string>();
  const out: ChatEscalationEntry[] = [];
  for (const key of keys) {
    for (const entry of (key && view.chats[key]) || []) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

export function useMarkEscalationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { chatId: string; sessionId?: string }) => {
      await apiClient.post(
        `/chat/${encodeURIComponent(input.chatId)}/escalations/read`,
        {},
        { params: params(input.sessionId) },
      );
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chatEscalations }),
  });
}
