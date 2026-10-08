import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectGitInfo } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

export function useProjectGit(path: string | undefined): UseQueryResult<ProjectGitInfo> {
  return useQuery({
    queryKey: ['project-git', path],
    queryFn: () => api.get<ProjectGitInfo>('/project-git', { path }),
    enabled: Boolean(path),
    staleTime: 10_000,
  });
}
