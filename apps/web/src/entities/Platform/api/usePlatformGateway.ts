import type { PlatformGatewayInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getGateway(): Promise<PlatformGatewayInfo> {
  const { data } = await apiClient.get<PlatformGatewayInfo>('/platforms/gateway');
  return data;
}

/**
 * Состояние локального шлюза. Отдельный запрос от списка: слушатель один на все
 * контуры, и его порт с адресами — не свойство конкретного контура.
 */
export function usePlatformGateway() {
  return useQuery({ queryKey: queryKeys.platformGateway, queryFn: getGateway });
}
