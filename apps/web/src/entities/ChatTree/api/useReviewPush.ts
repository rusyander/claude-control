import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitReviewOutcome } from '@agentdeck/contracts/chat-handoff';

export function useReviewPush() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; chatId: string }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-push`,
        { chatId: input.chatId },
      );
      return data;
    },
  });
}
