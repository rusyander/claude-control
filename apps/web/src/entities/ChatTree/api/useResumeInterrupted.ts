import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * «Продолжить» оборванные группы (WP1c): без номера — все, с номером — одну.
 * Адресуется РОДИТЕЛЮ: он знает, какие из его групп оборвались.
 */
export function useResumeInterrupted() {
  return useMutation({
    // Отказ показывает вызов своим тостом; общий из MutationCache встал бы
    // вторым, с сырым текстом сервера (живой прогон 26.09, F4).
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index?: number }) => {
      const { data } = await apiClient.post<{ resumed: number[]; refused: number[] }>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/resume`,
        input.index === undefined ? {} : { index: input.index },
      );
      return data;
    },
  });
}
