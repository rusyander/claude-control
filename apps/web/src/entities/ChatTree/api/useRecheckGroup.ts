import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitGroupRechecked } from '@agentdeck/contracts/chat-handoff';

/** «Перепроверить MR» доставленной группы: конфликты, замечания, конвейер, готовность задач. */
export function useRecheckGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<SplitGroupRechecked>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/recheck`,
        { index: input.index },
      );
      return data;
    },
  });
}
