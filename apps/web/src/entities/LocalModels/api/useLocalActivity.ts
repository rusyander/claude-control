import { useQuery } from '@tanstack/react-query';
import type { LocalActivity } from '@agentdeck/contracts/local-models';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

async function getLocalActivity(): Promise<LocalActivity> {
  const { data } = await apiClient.get<LocalActivity>('/local-models/activity');
  return data;
}

/** Раз в полторы секунды: разбор промпта у видеокарты — тысячи токенов в секунду, полоса должна двигаться. */
const ACTIVITY_INTERVAL_MS = 1500;

/**
 * Этап локального прогона для чата (L6). Опрос — только пока ход идёт: ответ дешёвый
 * (снимок присмотра шлюза, без запросов к серверу моделей), но и он не нужен простою.
 * `poll: false` — один запрос без опроса: между ходами чату нужен лишь замер слоя.
 */
export function useLocalActivity(enabled: boolean, poll = enabled) {
  return useQuery({
    queryKey: queryKeys.localActivity,
    queryFn: getLocalActivity,
    enabled,
    refetchInterval: enabled && poll ? ACTIVITY_INTERVAL_MS : false,
  });
}
