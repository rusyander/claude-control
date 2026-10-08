import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { KEY } from './ChatAutoModeApi.constants';

/** Выбрать авторежим в этом чате. Идущий прогон получает его сразу же. */
export function useSetChatAutoMode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { chatId: string; enabled: boolean }) => {
      await apiClient.post(`/chat/${encodeURIComponent(input.chatId)}/auto-approve`, {
        enabled: input.enabled,
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}
