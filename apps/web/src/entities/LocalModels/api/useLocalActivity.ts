import { useQuery } from '@tanstack/react-query';
import type { LocalActivity } from '@agentdeck/contracts/local-models';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

async function getLocalActivity(): Promise<LocalActivity> {
  const { data } = await apiClient.get<LocalActivity>('/local-models/activity');
  return data;
}

/** Раз в полторы секунды: отказ сервера моделей должен появиться под ходом сразу, не через ход. */
const ACTIVITY_INTERVAL_MS = 1500;

/**
 * Сервер, отказ и этап хода локальной модели для чата (L6; этап — по ленте звена ядра, этап 11).
 * Опрос — только пока ход идёт: ответ дешёвый (запись о сервере, снимок журнала запросов ядра и
 * ленты звена; сам сервер моделей панель не спрашивает), но и он не нужен простою.
 */
export function useLocalActivity(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.localActivity,
    queryFn: getLocalActivity,
    enabled,
    refetchInterval: enabled ? ACTIVITY_INTERVAL_MS : false,
  });
}
