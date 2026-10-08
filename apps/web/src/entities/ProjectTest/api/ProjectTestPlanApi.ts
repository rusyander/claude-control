import { useQuery } from '@tanstack/react-query';
import type { ProjectTestPlan } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Тест-планы и развёрнутые из них тест-поинты.
 *
 * План хранится файлом (`plans/<id>.plan.json`), а поинты не хранятся вовсе:
 * их считает сервер из кейсов, окружений и параметров в момент запроса. Поэтому
 * список поинтов — отдельный запрос, а не поле плана: он меняется от любой
 * правки кейса, и держать его в плане значило бы врать о размере работы.
 */

export function useTestPlans(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.plans(path),
    queryFn: async () => {
      const { data } = await apiClient.get<{ plans: ProjectTestPlan[] }>('/project-tests/plans', {
        params: { path },
      });
      return data.plans;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
