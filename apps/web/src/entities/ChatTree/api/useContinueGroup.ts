import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitGroupContinued } from '@agentdeck/contracts/chat-handoff';

/** «Продолжить» группу, остановившуюся недоделанной: сбой, кончились повторы, нет итога ревью. */
export function useContinueGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; force?: boolean }) => {
      const { data } = await apiClient.post<SplitGroupContinued>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/continue-group`,
        { index: input.index, ...(input.force ? { force: true } : {}) },
      );
      return data;
    },
  });
}
