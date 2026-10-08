import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { GroupAdviceResult } from '../model/types';
import { invalidateAfterWrite } from '../lib/invalidateAfterWrite';

/**
 * Копия проектной группы в общие каталоги провайдера. Ответ — новая группа и
 * советы по каждому участнику; ничего из советов ещё не применено.
 */
export function useCopyToGlobal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; provider: string }) => {
      const { data } = await apiClient.post<GroupAdviceResult>(
        `/groups/${input.id}/copy-to-global`,
        { provider: input.provider },
      );
      return data;
    },
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}
