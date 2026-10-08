import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProjectDraft, ProjectAdded } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Добавить проект в реестр по пути к его каталогу. Ответ несёт и итог папки e2e
 * (`ProjectAdded.e2e`): завела её панель, нашлась своя или не вышло.
 */
export function useAddProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProjectDraft) => {
      const { data } = await apiClient.post<ProjectAdded>('/projects', draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    meta: { successMessage: 'toasts.created' },
  });
}
