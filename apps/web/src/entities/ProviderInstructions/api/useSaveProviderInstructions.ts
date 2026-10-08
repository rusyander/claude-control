import type { Scope } from './ProviderInstructionsApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { listKey } from '../lib/listKey';
import { queryKeys } from '@shared/api/query-keys';

/** Bulk-сохранение полного списка (порядок значим — это порядок подключения). */
export function useSaveProviderInstructions({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entries: string[]): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(basePath(projectId), { entries });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
