import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { foreignKeys } from './api.constants';

/** Отправить ждущую очередь, когда её некому отпустить (ответ остановили, панель перезапускалась). */
export function useSendQueuedForeign(
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, string>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (queuedId) =>
      api.post(
        `/provider-chat/chats/${encodeURIComponent(chatId)}/queue/${encodeURIComponent(queuedId)}/send`,
      ),
    onSettled: () => void client.invalidateQueries({ queryKey: foreignKeys.all }),
  });
}
