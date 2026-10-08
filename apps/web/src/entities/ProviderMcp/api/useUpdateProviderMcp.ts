import { useInvalidateProviderMcp } from './useInvalidateProviderMcp';
import { useMutation } from '@tanstack/react-query';
import type { UniversalMcpServerDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useUpdateProviderMcp() {
  const invalidate = useInvalidateProviderMcp();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      draft: UniversalMcpServerDraft;
    }): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(
        `/provider-mcp/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: invalidate,
    meta: { successMessage: 'toasts.saved' },
  });
}
