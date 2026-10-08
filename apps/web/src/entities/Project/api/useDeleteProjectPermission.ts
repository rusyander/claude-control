import { useInvalidatePermissions } from './useInvalidatePermissions';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { WriteResult } from '@agentdeck/contracts';

export function useDeleteProjectPermission(projectId: string) {
  const invalidate = useInvalidatePermissions(projectId);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete<WriteResult>(
        `/projects/${projectId}/permissions/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.deleted' },
  });
}
