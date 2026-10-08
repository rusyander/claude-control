import type { Scope } from './ProviderSkillsApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderSkillDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';
import { skillKey } from '../lib/skillKey';
import { infoKey } from '../lib/infoKey';
import { queryKeys } from '@shared/api/query-keys';

/** Создание и обновление — один и тот же PUT: путь скилла и есть его идентичность. */
export function useSaveProviderSkill({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderSkillDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/skill`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: skillKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
