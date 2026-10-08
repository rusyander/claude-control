import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { PortHoldersInfo } from '@agentdeck/contracts';
import { portKey } from '../lib/portKey';
import { projectRunnerKey } from './ProjectRunnerApi.constants';

/**
 * Освободить порт — погасить занявшие его процессы. Вызывается только по клику
 * пользователя: панель сама чужие процессы не трогает.
 */
export function useFreePort() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async ({ port }: { port: number }) => {
      const { data } = await apiClient.post<PortHoldersInfo>('/project-runner/free-port', { port });
      return data;
    },
    onSuccess: (info) => {
      queryClient.setQueryData(portKey(info.port), info);
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}
