import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Skill, SkillDraft, WriteResult } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const skillApi = createEntityApi<Skill, SkillDraft>({
  resource: 'skills',
  listKey: queryKeys.skills,
  kind: 'skill',
});

/**
 * Переименовать скилл: имя папки — это его идентификатор, поэтому смена имени
 * переименовывает папку на диске и переносит отметки (выключение, группы).
 */
export function useRenameSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; newId: string }): Promise<WriteResult> => {
      const { data } = await apiClient.post<WriteResult>(
        `/skills/${encodeURIComponent(input.id)}/rename`,
        { newId: input.newId },
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.renamed' },
  });
}
