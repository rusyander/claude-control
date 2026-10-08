import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { PathStep, GroupPathView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Весь список своих шагов одним запросом: вставка, перенос, правка и удаление — одна запись. */
export function useSaveGroupPathSteps(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (steps: PathStep[]) => {
      const { data } = await apiClient.put<GroupPathView>(`/groups/${id}/path/steps`, { steps });
      return data;
    },
    onSuccess: (view) => queryClient.setQueryData(queryKeys.groupPath(id), view),
    meta: { successMessage: 'toasts.saved' },
  });
}
