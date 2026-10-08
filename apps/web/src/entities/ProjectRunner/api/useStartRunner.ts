import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { RunnerTargetRef } from './ProjectRunnerApi.types';
import { apiClient } from '@shared/api/client';
import type { ProjectRunnerView } from '@agentdeck/contracts';
import { projectRunnerKey } from './ProjectRunnerApi.constants';

/** Запустить dev-сервер цели (сервер сам откроет браузер, когда узнает адрес). */
export function useStartRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    // Отказ показывает вызов своим тостом; общий из MutationCache встал бы
    // вторым, с сырым текстом сервера (живой прогон 26.09, F4).
    meta: { silentError: true },
    mutationFn: async ({ path, dir, command }: RunnerTargetRef & { command?: string }) => {
      const { data } = await apiClient.post<ProjectRunnerView>('/project-runner/start', {
        path,
        dir,
        command,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}
