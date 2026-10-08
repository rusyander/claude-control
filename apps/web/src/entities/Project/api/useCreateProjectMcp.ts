import { useInvalidateMcp } from './useInvalidateMcp';
import { useMutation } from '@tanstack/react-query';
import type { McpServerDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useCreateProjectMcp(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (draft: McpServerDraft) => {
      const { data } = await apiClient.post<WriteResult>(`/projects/${projectId}/mcp`, draft);
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.created' },
  });
}
