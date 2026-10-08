import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { foreignKeys } from './api.constants';

export function useStopForeign(
  providerId: string,
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, void>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationFn: () => api.post(`/provider-chat/chats/${encodeURIComponent(chatId)}/stop`),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: foreignKeys.chat(providerId, chatId) }),
  });
}
