import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { RunnerTargetRef } from './ProjectRunnerApi.types';
import { apiClient } from '@shared/api/client';
import { projectRunnerKey } from './ProjectRunnerApi.constants';

/** Остановить dev-сервер цели. */
export function useStopRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async ({ path, dir }: RunnerTargetRef) => {
      const { data } = await apiClient.post<{ ok: boolean }>('/project-runner/stop', { path, dir });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}
