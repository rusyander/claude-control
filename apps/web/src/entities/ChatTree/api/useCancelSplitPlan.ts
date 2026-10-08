import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitPlanCancelled } from '@agentdeck/contracts/chat-handoff';

/**
 * «Отменить план» разделения (W3-5): сервер останавливает прогоны групп и
 * закрывает план; чаты и ветки остаются, разделить можно заново.
 */
export function useCancelSplitPlan() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string }) => {
      const { data } = await apiClient.post<SplitPlanCancelled>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/cancel`,
      );
      return data;
    },
  });
}
