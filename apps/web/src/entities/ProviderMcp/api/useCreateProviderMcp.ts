import { useInvalidateProviderMcp } from './useInvalidateProviderMcp';
import { useMutation } from '@tanstack/react-query';
import type { UniversalMcpServerDraft, WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useCreateProviderMcp() {
  const invalidate = useInvalidateProviderMcp();
  return useMutation({
    mutationFn: async (draft: UniversalMcpServerDraft): Promise<WriteResult> => {
      const { data } = await apiClient.post<WriteResult>('/provider-mcp', draft);
      return data;
    },
    onSuccess: invalidate,
    meta: { successMessage: 'toasts.created' },
  });
}
