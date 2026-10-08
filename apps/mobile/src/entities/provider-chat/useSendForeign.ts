import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { foreignKeys } from './api.constants';

/**
 * Вопрос. `queueIfBusy` — всегда: идёт ответ — слово уйдёт в него же, если CLI
 * это умеет, иначе дождётся конца в очереди сервера. Отказа «занято» телефон не
 * показывает: человек не за столом, чтобы отправить ещё раз.
 */
export function useSendForeign(
  providerId: string,
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, string>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (text) =>
      api.post(`/provider-chat/chats/${encodeURIComponent(chatId)}/send`, {
        text,
        queueIfBusy: true,
      }),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: foreignKeys.chat(providerId, chatId) }),
  });
}
