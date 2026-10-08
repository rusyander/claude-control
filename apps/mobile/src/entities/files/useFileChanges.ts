import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectFileChanges } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

/**
 * Что агент изменил в этом разговоре. База сравнения восстанавливается сервером
 * ОБРАТНЫМ проигрыванием транскрипта, а не из git, — поэтому список честен и в
 * репозитории с грязным рабочим деревом.
 */
export function useFileChanges(
  projectPath: string | undefined,
  chatId: string | undefined,
): UseQueryResult<ProjectFileChanges> {
  return useQuery({
    queryKey: ['project-files', 'changes', projectPath, chatId],
    queryFn: () =>
      api.get<ProjectFileChanges>('/project-files/changes', { path: projectPath, chatId }),
    enabled: Boolean(projectPath),
    staleTime: 10_000,
  });
}
