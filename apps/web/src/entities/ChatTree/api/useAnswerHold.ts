import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';

/**
 * Ответ человека на вопрос разбора (Т1). Адресуется РОДИТЕЛЮ, а не чату
 * группы: у стоящей группы чата ещё нет — копия заводится после ответа, и
 * ответ уезжает в её план и в работу заметкой.
 */
export function useAnswerHold() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; answer: string }) => {
      const { data } = await apiClient.post<TaskSplitResult>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/hold`,
        { index: input.index, answer: input.answer },
      );
      return data;
    },
  });
}
