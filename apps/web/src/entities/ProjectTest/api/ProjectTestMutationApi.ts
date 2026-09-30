import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectTestMutationMode, ProjectTestMutationView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { TESTS_POLL_MS, testKeys } from './keys';

/**
 * Проверка набора поломкой: в копии репозитория файл ломается, привязанные к
 * нему автокейсы прогоняются. Идёт минуты — вид перечитывается, пока она идёт.
 */
export function useMutationCheck(path: string | undefined) {
  return useQuery({
    queryKey: testKeys.mutation(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestMutationView>('/project-tests/mutation', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    refetchInterval: (query) =>
      query.state.data?.check?.status === 'running' ? TESTS_POLL_MS : false,
  });
}

export function useStartMutationCheck(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: string; mode: ProjectTestMutationMode }) => {
      const { data } = await apiClient.post<ProjectTestMutationView>('/project-tests/mutation', {
        path,
        ...input,
      });
      return data;
    },
    onSuccess: (data) => client.setQueryData(testKeys.mutation(path), data),
  });
}

export function useStopMutationCheck(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<ProjectTestMutationView>(
        '/project-tests/mutation/stop',
        { path },
      );
      return data;
    },
    onSuccess: (data) => client.setQueryData(testKeys.mutation(path), data),
  });
}
