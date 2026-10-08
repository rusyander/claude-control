import { useQuery } from '@tanstack/react-query';
import { describeKey } from '../lib/describeKey';
import { apiClient } from '@shared/api/client';
import type { ProjectRunnerInfo } from '@agentdeck/contracts';

/** Что в проекте можно запустить: корень и пакеты монорепозитория. */
export function useProjectRunnerInfo(path: string | undefined) {
  return useQuery({
    queryKey: describeKey(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectRunnerInfo>('/project-runner/describe', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    staleTime: 30_000,
  });
}
