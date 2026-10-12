import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { foreignKeys } from './api.constants';

/**
 * Ответ панели на «чистую сессию» у чужого CLI. Сессии у него нет: `started` —
 * заведён НОВЫЙ разговор в том же каталоге, `requested` — файл-опора ещё не
 * готов, и просьбу её обновить экран отправляет обычным сообщением.
 */
export type ForeignRestart =
  { mode: 'started'; chatId: string } | { mode: 'requested'; prompt: string };

export function useRestartForeign(
  providerId: string,
  chatId: string,
): ReturnType<typeof useMutation<ForeignRestart, Error, void>> {
  const client = useQueryClient();
  return useMutation<ForeignRestart, Error, void>({
    mutationFn: () =>
      api.post<ForeignRestart>(`/provider-chat/chats/${encodeURIComponent(chatId)}/restart`),
    onSuccess: () => void client.invalidateQueries({ queryKey: foreignKeys.list(providerId) }),
  });
}
