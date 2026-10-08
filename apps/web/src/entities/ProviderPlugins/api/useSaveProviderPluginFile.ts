import type { Scope } from './ProviderPluginsApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderPluginFileDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { fileKey } from '../lib/fileKey';
import { infoKey } from '../lib/infoKey';
import { queryKeys } from '@shared/api/query-keys';

/** Создание и обновление — один и тот же PUT: путь файла и есть его идентичность. */
export function useSaveProviderPluginFile({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderPluginFileDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/file`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: fileKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
