import { useInvalidatePermissions } from './useInvalidatePermissions';
import { useMutation } from '@tanstack/react-query';
import type { PermissionDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useUpdateProjectPermission(projectId: string) {
  const invalidate = useInvalidatePermissions(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; draft: PermissionDraft }) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/permissions/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.saved' },
  });
}
