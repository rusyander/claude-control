import type { PlatformBridgeInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function connectBridge(): Promise<PlatformBridgeInfo> {
  const { data } = await apiClient.post<PlatformBridgeInfo>('/platforms/mcp/connect');
  return data;
}

export async function disconnectBridge(): Promise<PlatformBridgeInfo> {
  const { data } = await apiClient.delete<PlatformBridgeInfo>('/platforms/mcp/connect');
  return data;
}

/**
 * Подключить или убрать переходник. Запись уходит в конфигурацию CLI, поэтому
 * сбрасывается и список MCP-серверов: раздел «MCP» показывает тот же файл.
 */
export function useConnectPlatformBridge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connect: boolean) => (connect ? connectBridge() : disconnectBridge()),
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.platformMcp, info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
    },
  });
}
