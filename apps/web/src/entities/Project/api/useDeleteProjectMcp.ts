import { useInvalidateMcp } from './useInvalidateMcp';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { WriteResult } from '@agentdeck/contracts';

export function useDeleteProjectMcp(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete<WriteResult>(
        `/projects/${projectId}/mcp/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.deleted' },
  });
}
