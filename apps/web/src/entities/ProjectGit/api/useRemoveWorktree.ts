import { useWorktreeAction } from './useWorktreeAction';

/**
 * Убрать копию. `force` нужен там, где внутри осталась незакоммиченная работа:
 * без него git отказывается, и это правильный отказ — панель лишь передаёт его
 * человеку и спрашивает ещё раз.
 */
export function useRemoveWorktree() {
  return useWorktreeAction<{ path: string; worktreePath: string; force?: boolean }>(
    '/project-git/worktrees/remove',
  );
}
