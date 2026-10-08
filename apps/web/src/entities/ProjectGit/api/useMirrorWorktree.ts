import { useWorktreeAction } from './useWorktreeAction';

/**
 * Повторно перенести локальный слой в копию — после правки шаблонов или
 * `.mcp.json` в основной копии. Ответ несёт отчёт: карточка копии его показывает.
 */
export function useMirrorWorktree() {
  return useWorktreeAction<{ path: string; worktreePath: string }>('/project-git/worktrees/mirror');
}
