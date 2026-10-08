import { useInvalidateProviderProjectMcp } from './useInvalidateProviderProjectMcp';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { WriteResult } from '@agentdeck/contracts';

export function useDeleteProviderProjectMcp(projectId: string) {
  const invalidate = useInvalidateProviderProjectMcp(projectId);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete<WriteResult>(
        `/projects/${projectId}/provider/mcp/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.deleted' },
  });
}
