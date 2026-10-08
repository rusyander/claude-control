import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitReviewOutcome } from '@agentdeck/contracts/chat-handoff';

/**
 * «Закоммитить и отправить в MR» (Т7) — вторым кликом после правок.
 *
 * Отдельной ручкой, а не решением: это запись в ЧУЖУЮ ветку. Панель её не
 * делает сама ни при каких настройках, и согласие человека на неё отдельное.
 */
/** «Повторить итог ревью» (Д4): то же сообщение в ту же сессию ревью. */
export function useReviewRetry() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; chatId: string }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-retry`,
        { chatId: input.chatId },
      );
      return data;
    },
  });
}
