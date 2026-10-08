import { useInvalidateProviderMcp } from './useInvalidateProviderMcp';
import { useMutation } from '@tanstack/react-query';
import type { WriteResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useDeleteProviderMcp() {
  const invalidate = useInvalidateProviderMcp();
  return useMutation({
    mutationFn: async (id: string): Promise<WriteResult> => {
      const { data } = await apiClient.delete<WriteResult>(
        `/provider-mcp/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: invalidate,
    meta: { successMessage: 'toasts.deleted' },
  });
}
