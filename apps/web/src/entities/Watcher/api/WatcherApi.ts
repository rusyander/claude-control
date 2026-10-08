import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WatcherStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import {
  setWatchCaptureEnabled,
  setWatchThresholds,
  watchQueryCache,
} from '@shared/lib/watch-capture';

/**
 * Фоновый наблюдатель: статус и тумблер.
 *
 * Статус опрашивается всегда — индикатор в боковой панели обязан появиться и
 * тогда, когда наблюдатель включили с телефона или он продолжил работу после
 * перезапуска. Включён — чаще (расход и находки меняются), выключен — редко.
 * Отсюда же ставится флаг сбора проблем страницы: пока статус не пришёл или
 * наблюдатель выключен, страница не шлёт ни одного сигнала. Порог «загрузка
 * зависла» приходит со статусом, а смотрит за загрузками кэш запросов этого же
 * клиента — пока наблюдатель включён.
 */

const POLL_ON_MS = 3000;
const POLL_OFF_MS = 15_000;

async function getWatcher(): Promise<WatcherStatus> {
  const { data } = await apiClient.get<WatcherStatus>('/watcher');
  return data;
}

export function useWatcherStatus() {
  const query = useQuery({
    queryKey: queryKeys.watcher,
    queryFn: getWatcher,
    refetchInterval: (current) => (current.state.data?.enabled ? POLL_ON_MS : POLL_OFF_MS),
  });
  const queryClient = useQueryClient();
  const enabled = query.data?.enabled === true;
  const stuckLoadingMs = query.data?.thresholds?.stuckLoadingMs;
  useEffect(() => {
    if (stuckLoadingMs) setWatchThresholds({ stuckLoadingMs });
  }, [stuckLoadingMs]);
  useEffect(() => {
    setWatchCaptureEnabled(enabled);
    if (!enabled) return undefined;
    return watchQueryCache(queryClient.getQueryCache());
  }, [enabled, queryClient]);
  return query;
}
