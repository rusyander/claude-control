import type { Scope } from './ProviderHooksApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderHooksDraft, ProviderHookRulesDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { infoKey } from '../lib/infoKey';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Запись обоих событий одним PUT: черновик — это желаемое состояние целиком.
 * Пустое событие удаляет свой ключ из файла (панель не пишет пустых объектов).
 */
export function useSaveProviderHooks({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      draft: ProviderHooksDraft | ProviderHookRulesDraft,
    ): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(basePath(projectId), draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
