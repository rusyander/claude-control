import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestRunDiff } from '@agentdeck/contracts';

/**
 * Что изменилось с прошлого прогона.
 *
 * Запрос идёт, только когда сравнение открыли: считать дифф на каждый показ
 * истории — платить за ответ, которого никто не спрашивал. Ошибку («это первый
 * прогон») показывает сам блок сравнения, поэтому повторы здесь выключены.
 */
export function useTestRunDiff(
  path: string | undefined,
  id: string | undefined,
  baseId?: string,
  isEnabled = true,
) {
  return useQuery({
    queryKey: testKeys.diff(path, id, baseId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestRunDiff>('/project-tests/run/diff', {
        params: { path, id, baseId },
      });
      return data;
    },
    enabled: Boolean(path) && Boolean(id) && isEnabled,
    retry: false,
  });
}
