import { useQuery } from '@tanstack/react-query';
import type { ProjectTestMutationView } from '@agentdeck/contracts';
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
