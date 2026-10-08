import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/** «Убрать» оборванную до чата группу: закрыть её сбоем с причиной. */
export function useDropGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<{ index: number }>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/drop-group`,
        { index: input.index },
      );
      return data;
    },
  });
}
