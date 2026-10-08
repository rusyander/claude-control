import { useQuery } from '@tanstack/react-query';
import { worktreesKeyFor } from '../lib/worktreesKeyFor';
import { apiClient } from '@shared/api/client';
import type { ProjectWorktreesInfo } from '@agentdeck/contracts';

/**
 * Параллельные рабочие копии репозитория. Обновляются чаще состояния самого
 * репозитория и по той же причине, по какой список вообще нужен: пока смотришь
 * на него, агент внутри копии мог сменить ветку — показывать ту, что была при
 * создании, значит врать.
 */
export function useProjectWorktrees(path: string | undefined) {
  return useQuery({
    queryKey: worktreesKeyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectWorktreesInfo>('/project-git/worktrees', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    refetchOnWindowFocus: true,
    // Пока в какой-то копии идёт установка, список опрашивается часто: значок
    // «ставится» обязан смениться сам, а не по F5.
    refetchInterval: (query) =>
      query.state.data?.worktrees.some((item) => item.bootstrap?.status === 'running')
        ? 3_000
        : 15_000,
  });
}
