import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { ProviderEnvInfo } from '@agentdeck/contracts';

// --- Переменные окружения проекта (GEMINI-3: <проект>/.gemini/.env) ---

export function useProviderProjectEnv(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderEnv(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderEnvInfo>(`/projects/${projectId}/provider/env`);
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}
