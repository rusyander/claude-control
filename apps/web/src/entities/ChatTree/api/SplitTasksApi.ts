import { useQuery } from '@tanstack/react-query';
import type { SplitTaskOptions } from '@agentdeck/contracts/chat-handoff';
import { apiClient } from '@shared/api/client';
import type { SplitTasksScope } from './SplitTasksApi.types';

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
