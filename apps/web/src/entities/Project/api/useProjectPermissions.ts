import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { PermissionRule } from '@agentdeck/contracts';

// --- Права проекта ---

export function useProjectPermissions(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectPermissions(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<PermissionRule[]>(`/projects/${projectId}/permissions`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}
