import { useQuery } from '@tanstack/react-query';
import type { ProjectTestCoverage } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Матрица покрытия. Запрос POST, поэтому здесь `useQuery` с телом — это всё
 * равно чтение: сервер ничего не меняет, а JQL просто не помещается в адрес.
 */
export function useTestCoverage(path: string | undefined, jql: string, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.coverage(path, jql),
    queryFn: async () => {
      const { data } = await apiClient.post<ProjectTestCoverage>('/project-tests/coverage', {
        path,
        jql: jql || undefined,
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
