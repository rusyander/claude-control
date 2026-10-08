import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectTestManualSession } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { MANUAL_KEY } from './api.constants';
import { api } from '../../shared/api/client';

/**
 * Открытая сессия ручного прогона. `undefined` — её нет, и это НЕ ошибка:
 * экран показывает кнопку «начать», а не пустое место с крутилкой.
 */
export function useManualSession(
  projectPath: string | undefined,
): UseQueryResult<ProjectTestManualSession | undefined> {
  return useQuery({
    queryKey: [MANUAL_KEY, projectPath],
    queryFn: async () => {
      const body = await api.get<{ session?: ProjectTestManualSession }>('/project-tests/manual', {
        path: projectPath,
      });
      return body.session;
    },
    enabled: Boolean(projectPath),
    staleTime: 0,
  });
}
