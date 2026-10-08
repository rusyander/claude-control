import { useQuery } from '@tanstack/react-query';
import { projectGitKey } from './ProjectGitApi.constants';
import { normalizeProjectPath } from '@shared/lib/workspace';
import { apiClient } from '@shared/api/client';
import type { WorktreeBootstrapState } from '@agentdeck/contracts';

/** Полный лог последнего бутстрапа копии — по запросу, когда его раскрыли. */
export function useWorktreeBootstrapLog(path: string, worktreePath: string, enabled: boolean) {
  return useQuery({
    queryKey: [...projectGitKey, 'bootstrap-log', normalizeProjectPath(path), worktreePath],
    queryFn: async () => {
      const { data } = await apiClient.get<{ log: string; state: WorktreeBootstrapState | null }>(
        '/project-git/worktrees/bootstrap-log',
        { params: { path, worktreePath } },
      );
      return data;
    },
    enabled,
    // Пока установка идёт, лог растёт — дочитываем.
    refetchInterval: (query) => (query.state.data?.state?.status === 'running' ? 2_000 : false),
  });
}
