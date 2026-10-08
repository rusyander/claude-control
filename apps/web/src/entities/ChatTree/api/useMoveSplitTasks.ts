import { useMutation } from '@tanstack/react-query';
import type { SplitTasksScope } from './SplitTasksApi.types';
import { apiClient } from '@shared/api/client';
import type { SplitTasksMoved } from '@agentdeck/contracts/chat-handoff';

/** Перевести задачи кнопки в выбранный статус; ответ — итог по каждой задаче. */
export function useMoveSplitTasks() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: SplitTasksScope & { status: string; from?: string }) => {
      const { data } = await apiClient.post<SplitTasksMoved>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/tasks/move`,
        {
          status: input.status,
          ...(input.from ? { from: input.from } : {}),
          ...(input.index === undefined ? {} : { index: input.index }),
        },
      );
      return data;
    },
  });
}
