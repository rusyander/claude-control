import { useQueryClient } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';

/**
 * Перечитать список и переписку чата.
 *
 * Идентификатор можно передать явно — это важно для нового чата: он живёт под
 * временным номером, пока Claude Code не выдаст настоящий, и обновлять после
 * этого нужно уже настоящий. Иначе переписка, прочитанная в момент, когда
 * транскрипт ещё дописывался, так и осталась бы пустой.
 */
export function useRefreshChat(chatId: string | undefined) {
  const queryClient = useQueryClient();

  return (id: string | undefined = chatId): void => {
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: chatKeys.messages(id) });
    void queryClient.invalidateQueries({ queryKey: chatKeys.artifacts(id) });
  };
}
