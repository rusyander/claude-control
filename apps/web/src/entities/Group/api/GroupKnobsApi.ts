import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroupKnobsEdit, GroupKnobsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// «Числа» группы: настраиваемые числа скиллов-участников (кругов ревью,
// агентов на круг…) с умолчанием из текста скилла. Меняется значение у
// группы, сам скилл не правится.

/** Пока сервер дочитывает скиллы (`pending`), спрашиваем снова — выписка идёт моделью. */
const PENDING_POLL_MS = 3000;

export function useGroupKnobs(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groupKnobs(id),
    queryFn: async () => {
      const { data } = await apiClient.get<GroupKnobsView>(`/groups/${id}/knobs`);
      return data;
    },
    enabled,
    refetchInterval: (query) =>
      (query.state.data?.pending ?? []).length > 0 ? PENDING_POLL_MS : false,
  });
}

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
