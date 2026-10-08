import { useInvalidateMcp } from './useInvalidateMcp';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { WriteResult } from '@agentdeck/contracts';

export function useSetProjectMcpEnabled(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; isEnabled: boolean }) => {
      const { data } = await apiClient.post<WriteResult>(
        `/projects/${projectId}/mcp/${encodeURIComponent(input.id)}/enabled`,
        { isEnabled: input.isEnabled },
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.updated' },
  });
}
