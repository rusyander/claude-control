import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitOverlapView } from '@agentdeck/contracts/chat-handoff';

/**
 * Пересечения веток разделения (Т6) по кнопке в хабе.
 *
 * Это ЧТЕНИЕ, а не действие, и всё же мутация: считает его сервер запросами к
 * git, длится это секунды, и нажатие должно крутить кнопку, а не молча висеть в
 * кэше. Результат приезжает и сам — вместе с деревом, которое пульт и так
 * опрашивает: ответ здесь нужен только чтобы понять, чем кончилось нажатие.
 */
export function useCheckOverlap() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (parentChatId: string) => {
      const { data } = await apiClient.get<SplitOverlapView>(
        `/chat/split/${encodeURIComponent(parentChatId)}/overlap`,
      );
      return data;
    },
  });
}
