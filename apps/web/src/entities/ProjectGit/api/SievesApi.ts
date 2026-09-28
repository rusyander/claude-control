import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SievesView } from '@agentdeck/contracts/sieves';
import { apiClient } from '@shared/api/client';
import { projectGitKey } from './ProjectGitApi';

/**
 * Сита перед MR — вкладка «Группы» в настройках: выученные по тредам MR и счёт
 * блокеров по классам. Встроенные сита — каталог контракта, сервер их не отдаёт.
 */
const sievesKey = [...projectGitKey, 'sieves'] as const;

export function useSieves() {
  return useQuery({
    queryKey: sievesKey,
    queryFn: async () => {
      const { data } = await apiClient.get<SievesView>('/sieves');
      return data;
    },
  });
}

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
