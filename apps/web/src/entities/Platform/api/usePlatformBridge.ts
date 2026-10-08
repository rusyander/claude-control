import type { PlatformBridgeInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/** Переходник MCP: одна ручка на три действия — узнать, подключить, убрать. */
export async function getBridge(): Promise<PlatformBridgeInfo> {
  const { data } = await apiClient.get<PlatformBridgeInfo>('/platforms/mcp/connect');
  return data;
}

/** Зарегистрирован ли переходник контура в конфигурации активного CLI. */
export function usePlatformBridge() {
  return useQuery({ queryKey: queryKeys.platformMcp, queryFn: getBridge });
}
