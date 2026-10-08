import { useWorktreeAction } from './useWorktreeAction';

/** Повторить бутстрап копии (установку зависимостей) — после провала или смены команды. */
export function useBootstrapWorktree() {
  return useWorktreeAction<{ path: string; worktreePath: string }>(
    '/project-git/worktrees/bootstrap',
  );
}
