import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { DevRestartStatus } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';

export function useRequestDevRestart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<DevRestartStatus>('/dev-restart');
      return data;
    },
    // Отказ называет сама плашка своим тостом — общий дал бы второй.
    meta: { silentError: true },
    onSuccess: (status) => queryClient.setQueryData(queryKeys.devRestart, status),
  });
}
