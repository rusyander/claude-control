import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectFileContent } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

export function useFileContent(
  projectPath: string | undefined,
  file: string | undefined,
  chatId: string | undefined,
): UseQueryResult<ProjectFileContent> {
  return useQuery({
    queryKey: ['project-files', 'content', projectPath, file, chatId],
    queryFn: () =>
      api.get<ProjectFileContent>('/project-files/content', {
        path: projectPath,
        file,
        chatId,
      }),
    enabled: Boolean(projectPath && file),
  });
}
