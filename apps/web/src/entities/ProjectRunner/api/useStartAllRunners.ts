import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectRunnerStartAllResult } from '@agentdeck/contracts';
import { projectRunnerKey } from './ProjectRunnerApi.constants';

/**
 * «Запустить всё»: поднять отмеченные цели проекта. Отказ одной цели не
 * останавливает остальные — он приходит в `failed` с причиной.
 */
export function useStartAllRunners() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async ({ path }: { path: string }) => {
      const { data } = await apiClient.post<ProjectRunnerStartAllResult>(
        '/project-runner/start-all',
        { path },
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}
