import { useQuery } from '@tanstack/react-query';
import type { EndpointsInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getEndpoints(profileId: string): Promise<EndpointsInfo> {
  const { data } = await apiClient.get<EndpointsInfo>('/endpoints', {
    params: profileId ? { profile: profileId } : undefined,
  });
  return data;
}

/**
 * Профили своего эндпоинта, маски токенов и готовность каждого CLI. Сервер
 * только читает настройки и реестр — в сеть этот запрос НЕ ходит, поэтому его
 * можно звать при каждом открытии настроек.
 */
export function useEndpoints(profileId: string) {
  return useQuery({
    queryKey: queryKeys.endpoints(profileId),
    queryFn: () => getEndpoints(profileId),
  });
}
