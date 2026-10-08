import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectWorktreesInfo } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

/**
 * Параллельные копии проекта. Отдельный запрос, а не поле пульта: список копий
 * требует похода в git по каждой из них, и пульт, который перечитывается после
 * каждой операции, платил бы за это на ровном месте. Держится дольше пульта —
 * копии заводят с компьютера, и на телефоне они меняются редко.
 */
export function useProjectWorktrees(
  path: string | undefined,
): UseQueryResult<ProjectWorktreesInfo> {
  return useQuery({
    queryKey: ['project-worktrees', path],
    queryFn: () => api.get<ProjectWorktreesInfo>('/project-git/worktrees', { path }),
    enabled: Boolean(path),
    staleTime: 30_000,
  });
}
