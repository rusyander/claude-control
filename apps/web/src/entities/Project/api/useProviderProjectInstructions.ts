import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { ProviderProjectInstructions } from '@agentdeck/contracts';

// --- Инструкции проекта ---

export function useProviderProjectInstructions(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderInstructions(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderProjectInstructions>(
        `/projects/${projectId}/provider/instructions`,
      );
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}
