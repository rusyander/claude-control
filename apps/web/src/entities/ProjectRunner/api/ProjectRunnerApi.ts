import { useQuery } from '@tanstack/react-query';
import type { ProjectRunnerView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { projectRunnerKey } from './ProjectRunnerApi.constants';

/** Список запущенных dev-серверов; поллинг ~2с. */
export function useProjectRunners() {
  return useQuery({
    queryKey: projectRunnerKey,
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectRunnerView[]>('/project-runner');
      return data;
    },
    refetchInterval: 2_000,
  });
}
