import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { DiscoveryView } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';

export function useRunDiscovery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiClient.post('/groups/discovery/run', {});
    },
    // Сразу помечаем «идёт»: иначе до первого ответа опроса кнопка снова
    // выглядела бы свободной и звала второй прогон.
    onSuccess: () => {
      queryClient.setQueryData<DiscoveryView>(queryKeys.groupDiscovery, (view) =>
        view ? { ...view, running: true } : view,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.groupDiscovery });
    },
  });
}
