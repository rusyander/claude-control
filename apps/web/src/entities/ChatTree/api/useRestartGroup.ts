import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Группа, оборванная до своего чата (живой прогон 29.09): «Завести заново» в её
 * копии. Потолок её не держит — место она держала сама; лимит — 409 со сроком.
 */
export function useRestartGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; force?: boolean }) => {
      const { data } = await apiClient.post<{ index: number }>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/restart-group`,
        { index: input.index, ...(input.force ? { force: true } : {}) },
      );
      return data;
    },
  });
}
