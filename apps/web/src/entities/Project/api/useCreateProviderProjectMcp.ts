import { useInvalidateProviderProjectMcp } from './useInvalidateProviderProjectMcp';
import { useMutation } from '@tanstack/react-query';
import type { UniversalMcpServerDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useCreateProviderProjectMcp(projectId: string) {
  const invalidate = useInvalidateProviderProjectMcp(projectId);
  return useMutation({
    mutationFn: async (draft: UniversalMcpServerDraft) => {
      const { data } = await apiClient.post<WriteResult>(
        `/projects/${projectId}/provider/mcp`,
        draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.created' },
  });
}
