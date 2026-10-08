import type { ProviderDetectResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getProviderDetect(): Promise<ProviderDetectResponse> {
  const { data } = await apiClient.get<ProviderDetectResponse>('/providers/detect/detect');
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
