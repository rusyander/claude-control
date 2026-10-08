import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestPoint } from '@agentdeck/contracts';

/** Во что план разворачивается: кейс × окружение × набор параметров. */
export function useTestPlanPoints(
  path: string | undefined,
  planId: string | undefined,
  environmentId?: string,
) {
  return useQuery({
    queryKey: testKeys.points(path, planId, environmentId),
    queryFn: async () => {
      const { data } = await apiClient.get<{ points: ProjectTestPoint[] }>(
        '/project-tests/plan/points',
        { params: { path, id: planId, environmentId: environmentId || undefined } },
      );
      return data.points;
    },
    enabled: Boolean(path) && Boolean(planId),
  });
}
