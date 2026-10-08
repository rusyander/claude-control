import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { foreignKeys } from './api.constants';

/** Ответ на просьбу CLI о разрешении. Пропала (ход кончился) — сервер скажет 404 своим текстом. */
export function useAnswerForeignPermission(
  providerId: string,
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, { askId: string; decision: 'allow' | 'deny' }>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, { askId: string; decision: 'allow' | 'deny' }>({
    mutationFn: ({ askId, decision }) =>
      api.post(
        `/provider-chat/chats/${encodeURIComponent(chatId)}/permissions/${encodeURIComponent(askId)}`,
        { decision },
      ),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: foreignKeys.status(providerId, chatId) }),
  });
}
