import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { ProviderMcpInfo } from '@agentdeck/contracts';

// --- MCP-серверы проекта ---

export function useProviderProjectMcp(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderMcp(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderMcpInfo>(`/projects/${projectId}/provider/mcp`);
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}
