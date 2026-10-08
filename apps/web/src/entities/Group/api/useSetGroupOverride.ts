import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { GroupOverrideResult } from '../model/types';
import { queryKeys } from '@shared/api/query-keys';

export function useSetGroupOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; path: string; enabled: boolean }) => {
      const { data } = await apiClient.put<GroupOverrideResult>(`/groups/${input.id}/override`, {
        path: input.path,
        enabled: input.enabled,
      });
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups }),
    meta: { successMessage: 'toasts.updated' },
  });
}
