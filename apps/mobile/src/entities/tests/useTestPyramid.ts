import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectTestPyramid } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { KEY } from './api.constants';
import { api } from '../../shared/api/client';

/**
 * Пирамида тестов проекта — только чтение. Сервер обходит весь проект, поэтому
 * без опроса: экран перечитывает её, когда его тянут вниз.
 */
export function useTestPyramid(
  projectPath: string | undefined,
): UseQueryResult<ProjectTestPyramid> {
  return useQuery({
    queryKey: [KEY, 'pyramid', projectPath],
    queryFn: () => api.get<ProjectTestPyramid>('/project-tests/pyramid', { path: projectPath }),
    enabled: Boolean(projectPath),
    staleTime: 5 * 60_000,
  });
}
