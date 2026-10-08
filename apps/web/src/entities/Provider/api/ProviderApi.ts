import { useQuery } from '@tanstack/react-query';
import type { ProvidersResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Провайдеры конфигурации: активный id и карта возможностей каждого. Данные
 * статичны в пределах сессии (меняются только при смене настройки `provider`,
 * которая сама инвалидирует этот ключ), поэтому держим их «свежими» долго —
 * гейтинг навигации не должен мигать перезапросами.
 */

async function getProviders(): Promise<ProvidersResponse> {
  const { data } = await apiClient.get<ProvidersResponse>('/providers');
  return data;
}

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: getProviders,
    // Карта возможностей не меняется на диске — перезапрашивать незачем.
    staleTime: Infinity,
  });
}
