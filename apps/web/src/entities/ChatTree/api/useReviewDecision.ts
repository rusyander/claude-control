import { useMutation } from '@tanstack/react-query';
import type { TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import { apiClient } from '@shared/api/client';
import type { SplitReviewOutcome } from '@agentdeck/contracts/chat-handoff';

/**
 * Решение человека по ревью чужого MR (Т7). Адресуется РОДИТЕЛЮ с ключом
 * группы: «применить ко всем» — это про соседние группы того же дерева, и знает
 * их сервер.
 *
 * Ответ подробный (что записано в MR, что заведено), потому что решение
 * «и отписать, и починить» может сработать наполовину: комментарий отклонён
 * форджем, а правки пошли. Показать это обязана одна реплика.
 */
export function useReviewDecision() {
  return useMutation({
    mutationFn: async (input: {
      parentChatId: string;
      chatId: string;
      decision: TaskSplitReviewDecision;
      all?: boolean;
    }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-decision`,
        { chatId: input.chatId, decision: input.decision, ...(input.all ? { all: true } : {}) },
      );
      return data;
    },
  });
}
