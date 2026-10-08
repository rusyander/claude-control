import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { McpServer } from '@agentdeck/contracts';

// --- MCP-серверы проекта ---

export function useProjectMcp(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectMcp(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<McpServer[]>(`/projects/${projectId}/mcp`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}
