import { useMutation, useQuery } from '@tanstack/react-query';
import type { SplitTaskOptions, SplitTasksMoved } from '@agentdeck/contracts/chat-handoff';
import { apiClient } from '@shared/api/client';

/**
 * «Перевести задачи» групп разделения в трекере (G4). Переводит сама панель
 * своим клиентом Jira; `index` — задачи одной группы, без него — всего плана
 * с вложенными разделениями.
 */

export interface SplitTasksScope {
  parentChatId: string;
  index?: number;
}

export const splitTasksKeys = {
  options: (scope: SplitTasksScope) =>
    ['chat-tree', 'split-tasks', scope.parentChatId, scope.index ?? 'all'] as const,
};

/** Задачи кнопки, их статусы и статусы, общие для всех. Читается, пока окно открыто. */
export function useSplitTaskOptions(scope: SplitTasksScope, enabled: boolean) {
  return useQuery({
    queryKey: splitTasksKeys.options(scope),
    queryFn: async () => {
      const { data } = await apiClient.get<SplitTaskOptions>(
        `/chat/split/${encodeURIComponent(scope.parentChatId)}/tasks`,
        { params: scope.index === undefined ? {} : { index: scope.index } },
      );
      return data;
    },
    enabled,
    // Статус в Jira меняют и мимо панели: окно, открытое заново, читает свежий.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

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
