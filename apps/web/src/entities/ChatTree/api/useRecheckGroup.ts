import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitGroupRechecked } from '@agentdeck/contracts/chat-handoff';

/** «Перепроверить MR» доставленной группы: конфликты, замечания, конвейер, готовность задач. */
export function useRecheckGroup() {
  return useMutation({
    meta: { silentError: true },
    // `note` — заметка человека: уходит в задание перепроверки дословно.
    mutationFn: async (input: { parentChatId: string; index: number; note?: string }) => {
      const { data } = await apiClient.post<SplitGroupRechecked>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/recheck`,
        { index: input.index, ...(input.note ? { note: input.note } : {}) },
      );
      return data;
    },
  });
}
