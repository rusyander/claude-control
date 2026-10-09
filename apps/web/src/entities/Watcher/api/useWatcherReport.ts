import { useQuery } from '@tanstack/react-query';
import type { WatchReportView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Пока страница открыта, отчёт перечитывается: наблюдатель дописывает его на ходу. */
const POLL_MS = 10_000;

/** Отчёт наблюдателя разделами — тот же `WATCH-REPORT.md`, что на диске. */
export function useWatcherReport() {
  return useQuery({
    queryKey: queryKeys.watcherReport,
    queryFn: async () => {
      const { data } = await apiClient.get<WatchReportView>('/watcher/report');
      return data;
    },
    refetchInterval: POLL_MS,
  });
}
