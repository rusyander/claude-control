import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SievesView } from '@agentdeck/contracts/sieves';
import { sievesKey } from './SievesApi.constants';

export function useDeleteLearnedSieve() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete<SievesView>(
        `/sieves/learned/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: (result) => queryClient.setQueryData(sievesKey, result),
  });
}
