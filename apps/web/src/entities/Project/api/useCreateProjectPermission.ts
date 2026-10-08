import { useInvalidatePermissions } from './useInvalidatePermissions';
import { useMutation } from '@tanstack/react-query';
import type { PermissionDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useCreateProjectPermission(projectId: string) {
  const invalidate = useInvalidatePermissions(projectId);
  return useMutation({
    mutationFn: async (draft: PermissionDraft) => {
      const { data } = await apiClient.post<WriteResult>(
        `/projects/${projectId}/permissions`,
        draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.created' },
  });
}
