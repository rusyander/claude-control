import type { Scope } from './ProviderPluginsApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { infoKey } from '../lib/infoKey';
import { queryKeys } from '@shared/api/query-keys';

/** Список npm-плагинов целиком: пустой список удаляет ключ `plugin` из конфига. */
export function useSaveProviderPluginPackages({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (packages: string[]): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/packages`, {
        packages,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
