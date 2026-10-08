import type { PlatformSpendInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/** Снять отметку «бюджет исчерпан» — только по слову человека, см. маршрут. */
export async function clearExhausted(id: string): Promise<PlatformSpendInfo> {
  const { data } = await apiClient.delete<PlatformSpendInfo>(path(id, '/spend/exhausted'));
  return data;
}

/**
 * Снять отметку «бюджет исчерпан». Сбрасываем и список карточек: итог по
 * бюджету едет в нём, и карточка иначе продолжала бы утверждать отказ.
 */
export function useClearExhausted() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clearExhausted,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.platformSpend(info.platformId), info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
  });
}
