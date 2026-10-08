import { useWorktreeAction } from './useWorktreeAction';

/** Завести копию под ветку: своя папка, своя ветка, общая история. */
export function useAddWorktree() {
  return useWorktreeAction<{ path: string; name: string }>('/project-git/worktrees/add');
}
