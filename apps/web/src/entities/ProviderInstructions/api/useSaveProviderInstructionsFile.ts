import type { Scope } from './ProviderInstructionsApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { fileKey } from '../lib/fileKey';
import { listKey } from '../lib/listKey';
import { queryKeys } from '@shared/api/query-keys';

/** Запись содержимого перечисленного файла (бэкап + атомарно на сервере). */
export function useSaveProviderInstructionsFile({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: { path: string; content: string }): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/file`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: fileKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
