import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitStatusAsked } from '@agentdeck/contracts/chat-handoff';

/**
 * Вопрос о ходе групп (5.1 плана экономии): сервер заводит лёгкий чат со
 * сводкой групп и отвечает его ключом. Родителя вопрос не трогает.
 */
export function useAskSplitStatus() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; question: string }) => {
      const { data } = await apiClient.post<SplitStatusAsked>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/status-ask`,
        { question: input.question },
      );
      return data;
    },
  });
}
