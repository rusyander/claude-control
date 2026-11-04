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
 * Сервер и отказ локальной модели для чата (L6). Опрос — только пока ход идёт: ответ дешёвый
 * (запись о сервере и снимок журнала запросов ядра, без запросов к серверу моделей), но и он
 * не нужен простою.
 */
export function useLocalActivity(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.localActivity,
    queryFn: getLocalActivity,
    enabled,
    refetchInterval: enabled ? ACTIVITY_INTERVAL_MS : false,
  });
}
