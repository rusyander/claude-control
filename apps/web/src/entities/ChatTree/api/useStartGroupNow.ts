import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';

export function useStartGroupNow() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; force?: boolean }) => {
      const { data } = await apiClient.post<TaskSplitResult>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/start-now`,
        { index: input.index, ...(input.force ? { force: true } : {}) },
      );
      return data;
    },
  });
}
