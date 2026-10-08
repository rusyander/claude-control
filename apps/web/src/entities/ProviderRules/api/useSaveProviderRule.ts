import type { Scope } from './ProviderRulesApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderRuleDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { ruleKey } from '../lib/ruleKey';
import { listKey } from '../lib/listKey';
import { queryKeys } from '@shared/api/query-keys';

/** Создание и обновление — один и тот же PUT: путь правила и есть его идентичность. */
export function useSaveProviderRule({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderRuleDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/rule`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: ruleKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
