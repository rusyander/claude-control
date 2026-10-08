import { useInvalidateMcp } from './useInvalidateMcp';
import { useMutation } from '@tanstack/react-query';
import type { McpServerDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useUpdateProjectMcp(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; draft: McpServerDraft }) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/mcp/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.saved' },
  });
}
