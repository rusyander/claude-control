import { useQuery } from '@tanstack/react-query';
import type { LocalMcpInfo } from '@agentdeck/contracts/local-models';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * MCP-серверы проекта для локального прогона: цена каждого в токенах, что взято и
 * сколько окна остаётся на разговор. Спрашивается, когда человек открыл список, —
 * чтение файлов настроек и замер незачем делать на каждое открытие чата.
 */
export function useLocalMcp(project: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.localMcp(project),
    queryFn: async () => {
      const { data } = await apiClient.get<LocalMcpInfo>('/local-models/mcp', {
        params: { project },
      });
      return data;
    },
    enabled: project !== '' && (options.enabled ?? true),
  });
}
