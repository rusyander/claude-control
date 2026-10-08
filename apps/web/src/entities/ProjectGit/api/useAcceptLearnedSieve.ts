import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SievesView } from '@agentdeck/contracts/sieves';
import { sievesKey } from './SievesApi.constants';

/** Принять предложенное сито — для его проекта или для всех; только рукой человека. */
export function useAcceptLearnedSieve() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async ({ id, scope }: { id: string; scope: 'project' | 'global' }) => {
      const { data } = await apiClient.post<SievesView>(
        `/sieves/learned/${encodeURIComponent(id)}/accept`,
        { scope },
      );
      return data;
    },
    onSuccess: (result) => queryClient.setQueryData(sievesKey, result),
  });
}
