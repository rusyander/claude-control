import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * «Убрать» строку «разрешено автоматически» в хабе (аудит 25.09, L51): человек
 * увидел, что группа разрешила себе по строке «с отметкой», — отметки стираются.
 */
export function useDismissAutoNotices() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<{ index: number; dismissed: number }>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/auto-notices/dismiss`,
        { index: input.index },
      );
      return data;
    },
  });
}
