import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitGroupResumed } from '@agentdeck/contracts/chat-handoff';

export function useResumePausedGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; force?: boolean }) => {
      const { data } = await apiClient.post<SplitGroupResumed>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/resume-paused`,
        { index: input.index, ...(input.force ? { force: true } : {}) },
      );
      return data;
    },
  });
}
