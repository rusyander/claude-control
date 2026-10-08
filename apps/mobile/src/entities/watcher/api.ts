import { useQuery } from '@tanstack/react-query';
import type { WatcherStatus } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { KEY } from './api.constants';

/**
 * Состояние наблюдателя: пока включён — раз в 15 с (сводка и расход меняются
 * на глазах), выключенный спрашивается раз в минуту — только чтобы заметить,
 * что его включили в панели.
 */
export const WATCHER_POLL_MS = { on: 15_000, off: 60_000 } as const;

export function useWatcherStatus(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<WatcherStatus>('/watcher'),
    enabled,
    staleTime: 10_000,
    refetchInterval: (query) =>
      query.state.data?.enabled ? WATCHER_POLL_MS.on : WATCHER_POLL_MS.off,
  });
}
