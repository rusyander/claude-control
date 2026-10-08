import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';

/**
 * «Отпустить» группу, которая ждёт предшественников (Т1).
 *
 * Вторая и последняя дверь к стоящей группе: ответ на вопрос разбора двигает
 * только `held`, а цепочка предшественника может не кончиться никогда — прогон
 * остановили, чат удалили, панель перезапустилась. Адресуется, как и ответ,
 * РОДИТЕЛЮ с номером группы: чата у стоящей группы ещё нет.
 */
export function useReleaseGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<TaskSplitResult>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/release`,
        { index: input.index },
      );
      return data;
    },
  });
}
