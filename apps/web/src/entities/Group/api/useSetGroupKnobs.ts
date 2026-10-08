import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { GroupKnobsEdit, GroupKnobsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Новые значения одним запросом; `null` у числа — вернуть умолчание скилла. */
export function useSetGroupKnobs(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: GroupKnobsEdit['values']) => {
      const { data } = await apiClient.put<GroupKnobsView>(`/groups/${id}/knobs`, { values });
      return data;
    },
    onSuccess: (view) => queryClient.setQueryData(queryKeys.groupKnobs(id), view),
    meta: { successMessage: 'toasts.saved' },
  });
}
