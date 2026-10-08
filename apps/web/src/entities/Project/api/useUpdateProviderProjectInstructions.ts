import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { WriteResult } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';

export function useUpdateProviderProjectInstructions(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/provider/instructions`,
        { content },
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectProviderInstructions(projectId),
      });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
