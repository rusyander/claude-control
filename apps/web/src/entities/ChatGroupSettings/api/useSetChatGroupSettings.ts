import { useQueryClient, useMutation } from '@tanstack/react-query';
import type {
  StoredChatGroupSettings,
  ChatGroupSettingsView,
} from '@agentdeck/contracts/chat-group-settings';
import { apiClient } from '@shared/api/client';
import { params } from '../lib/params';
import { queryKeys } from '@shared/api/query-keys';

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
