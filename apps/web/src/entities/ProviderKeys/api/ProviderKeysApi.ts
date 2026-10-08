import { useQuery } from '@tanstack/react-query';
import type { ProviderKeysResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * API-ключи провайдеров и резолвинг раннера ассистента (Ф6a). Секреты наружу не
 * приходят: сервер отдаёт только маску (`sk-…last4`) и статус. Мутации возвращают
 * обновлённый маскированный статус, но не сам ключ.
 */

async function getProviderKeys(): Promise<ProviderKeysResponse> {
  const { data } = await apiClient.get<ProviderKeysResponse>('/provider-keys');
  return data;
}

export function useProviderKeys() {
  return useQuery({ queryKey: queryKeys.providerKeys, queryFn: getProviderKeys });
}
