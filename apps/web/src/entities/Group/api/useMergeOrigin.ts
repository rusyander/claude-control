import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { GroupAdviceResult } from '../model/types';

/** Предложение агента, как слить правки оригинала в нашу копию. Ничего не пишет. */
export function useMergeOrigin() {
  return useMutation({
    // Отказ окно слияния показывает само — с причиной и «Повторить».
    meta: { silentError: true },
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<GroupAdviceResult>(`/groups/${id}/merge-origin`, {});
      return data;
    },
  });
}
