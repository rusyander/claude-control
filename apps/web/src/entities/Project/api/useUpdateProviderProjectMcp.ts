import { useInvalidateProviderProjectMcp } from './useInvalidateProviderProjectMcp';
import { useMutation } from '@tanstack/react-query';
import type { UniversalMcpServerDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useUpdateProviderProjectMcp(projectId: string) {
  const invalidate = useInvalidateProviderProjectMcp(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; draft: UniversalMcpServerDraft }) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/provider/mcp/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.saved' },
  });
}
