import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { WatcherStatus } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';

export function useSetWatcher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await apiClient.post<WatcherStatus>('/watcher', { enabled });
      return data;
    },
    // Отказ называет каждый вызов своим тостом (карточка, окно индикатора) —
    // общий тост клиента дал бы второй на тот же отказ.
    meta: { silentError: true },
    // Ответ — уже новое состояние: кладём его в кэш, индикатор меняется сразу.
    onSuccess: (status) => queryClient.setQueryData(queryKeys.watcher, status),
  });
}
