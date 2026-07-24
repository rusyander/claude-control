import { useQuery } from '@tanstack/react-query';
import type { ProviderDetectResponse, ProvidersResponse } from '@claude-control/contracts';
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

async function getProviderDetect(): Promise<ProviderDetectResponse> {
  const { data } = await apiClient.get<ProviderDetectResponse>('/providers/detect');
  return data;
}

/**
 * Детект установленных провайдер-CLI (Ф7): бинарь в PATH и наличие каталога
 * конфигурации по каждому провайдеру. В отличие от карты возможностей, детект
 * зависит от состояния машины (пользователь может доставить CLI, не перезагружая
 * панель), поэтому держим его свежим недолго — минуту.
 */
export function useProviderDetect() {
  return useQuery({
    queryKey: queryKeys.providerDetect,
    queryFn: getProviderDetect,
    staleTime: 60_000,
  });
}
