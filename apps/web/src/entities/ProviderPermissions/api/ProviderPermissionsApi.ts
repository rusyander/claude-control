import { useQuery } from '@tanstack/react-query';
import type { ProviderPermissionInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Универсальные права/аппрувы активного провайдера (Codex). Отдельный от Claude
 * набор запросов: права Claude живут на своих богатых роутах (settings.json
 * allow/deny/ask) со своей страницей — клиент выбирает набор по активному
 * провайдеру. GET возвращает `ProviderPermissionInfo` (текущие значения +
 * допустимые наборы + метаданные). PUT сохраняет оба скалярных ключа корня.
 */

async function getProviderPermissions(): Promise<ProviderPermissionInfo> {
  const { data } = await apiClient.get<ProviderPermissionInfo>('/provider-permissions');
  return data;
}

export function useProviderPermissions() {
  return useQuery({
    queryKey: queryKeys.providerPermissions,
    queryFn: getProviderPermissions,
  });
}
