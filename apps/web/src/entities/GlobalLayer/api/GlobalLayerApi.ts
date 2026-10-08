import { useQuery } from '@tanstack/react-query';
import type { GlobalLayerResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getPairs(): Promise<GlobalLayerResponse> {
  const { data } = await apiClient.get<GlobalLayerResponse>('/global-layer');
  return data;
}

/**
 * Пока идёт сверка, карточка опрашивает раз в две секунды: конец сверки сервер
 * и так разошлёт, но при выключенном наблюдении за файлами рассылки нет.
 */
const COMPARING_INTERVAL_MS = 2000;

export function useGlobalLayer() {
  return useQuery({
    queryKey: queryKeys.globalLayer,
    queryFn: getPairs,
    refetchInterval: (query) =>
      query.state.data?.pairs.some((pair) => pair.comparing) ? COMPARING_INTERVAL_MS : false,
  });
}
