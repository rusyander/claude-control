import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitGroupPaused } from '@agentdeck/contracts/chat-handoff';

/**
 * Управление одной группой из хаба (журнал 81, 89). Адресуется РОДИТЕЛЮ с
 * номером группы — как ответ и «отпустить». `force` — согласие человека идти
 * сверх потолка или мимо лимита подписки: без него сервер отвечает 409 с числами.
 */
export function usePauseGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<SplitGroupPaused>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/pause`,
        { index: input.index },
      );
      return data;
    },
  });
}
