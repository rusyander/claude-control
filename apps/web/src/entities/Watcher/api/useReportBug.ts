import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WatchUserCheck, WatchUserReport } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Баг словами человека — на проверку наблюдателю. Ответ — запись проверки
 * («проверяется»); чем она кончилась, приходит в статусе (`checks`), который
 * при включённом наблюдателе опрашивается каждые три секунды.
 */
export function useReportBug() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (report: WatchUserReport) => {
      const { data } = await apiClient.post<{ check: WatchUserCheck }>('/watcher/reports', report);
      return data.check;
    },
    // Отказ называет окно наблюдателя своим тостом — общий дал бы второй.
    meta: { silentError: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.watcher }),
  });
}
