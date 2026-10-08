import type { Scope } from './ProviderPluginsApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { infoKey } from '../lib/infoKey';
import { queryKeys } from '@shared/api/query-keys';

/** Удаление файла: на сервере перед удалением делается резервная копия. */
export function useDeleteProviderPluginFile({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string): Promise<WriteResult> => {
      const { data } = await apiClient.delete<WriteResult>(`${basePath(projectId)}/file`, {
        params: { path },
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}
