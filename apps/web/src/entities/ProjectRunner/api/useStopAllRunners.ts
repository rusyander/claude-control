import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { projectRunnerKey } from './ProjectRunnerApi.constants';

/** «Остановить всё»: погасить все цели проекта, запущенные панелью. */
export function useStopAllRunners() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async ({ path }: { path: string }) => {
      const { data } = await apiClient.post<{ stopped: number }>('/project-runner/stop-all', {
        path,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}
