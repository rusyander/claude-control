import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { Group } from '@agentdeck/contracts';
import { invalidateAfterWrite } from '../lib/invalidateAfterWrite';

export function useApplyAdvice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; items: { kind: string; id: string }[] }) => {
      const { data } = await apiClient.post<Group>(`/groups/${input.id}/advice/apply`, {
        items: input.items,
      });
      return data;
    },
    onSuccess: () => invalidateAfterWrite(queryClient),
    meta: { successMessage: 'groupSources.adviceApplied' },
  });
}
