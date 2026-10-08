import type { Scope } from './ProviderRulesApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { listKey } from '../lib/listKey';
import { queryKeys } from '@shared/api/query-keys';

/** Удаление правила: на сервере перед удалением делается резервная копия. */
export function useDeleteProviderRule({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string): Promise<WriteResult> => {
      const { data } = await apiClient.delete<WriteResult>(`${basePath(projectId)}/rule`, {
        params: { path },
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}
