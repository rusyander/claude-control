import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { providerChatKeys } from './ProviderChatApi.constants';

/**
 * Ответ панели на кнопку «Перезапустить сессию» у чужого CLI (Т7). Сессии у него
 * нет: `started` — заведён НОВЫЙ разговор, `requested` — файл-опора ещё не готов,
 * и вкладка отправляет просьбу его обновить обычным сообщением.
 */
export interface ProviderChatRestart {
  mode: 'started' | 'requested';
  chatId?: string;
  chainDepth?: number;
  prompt?: string;
}

export function useRestartProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ProviderChatRestart>(
        `/provider-chat/chats/${chatId}/restart`,
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
    },
  });
}
