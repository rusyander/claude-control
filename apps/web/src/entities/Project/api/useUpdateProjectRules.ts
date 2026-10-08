import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { WriteResult } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';

export function useUpdateProjectRules(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Имя уходит ТОЛЬКО когда файла ещё нет: существующий панель не
    // переименовывает, и сервер на такую просьбу отвечает 409.
    mutationFn: async (draft: { content: string; fileName?: string }) => {
      const { data } = await apiClient.put<WriteResult>(`/projects/${projectId}/rules`, draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectRules(projectId) });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
