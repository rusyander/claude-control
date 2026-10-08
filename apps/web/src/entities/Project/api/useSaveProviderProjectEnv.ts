import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderEnvVar, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Bulk-сохранение полного набора переменных проекта (как и у глобального раздела). */
export function useSaveProviderProjectEnv(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: ProviderEnvVar[]) => {
      const { data } = await apiClient.put<WriteResult>(`/projects/${projectId}/provider/env`, {
        vars,
      });
      return data;
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectProviderEnv(projectId) }),
    meta: { successMessage: 'toasts.saved' },
  });
}
