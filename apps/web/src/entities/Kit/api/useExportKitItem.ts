import type { KitResponse } from '@agentdeck/contracts/kit';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Ответ записи в глобальный слой: набор целиком и путь резервной копии, если она была. */
export interface KitExportResult {
  kit: KitResponse;
  backup?: string;
}

export function useExportKitItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<KitExportResult>('/kit/global/export', { id });
      return data;
    },
    onSuccess: (result) => queryClient.setQueryData(queryKeys.kit, result.kit),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.kit }),
  });
}
