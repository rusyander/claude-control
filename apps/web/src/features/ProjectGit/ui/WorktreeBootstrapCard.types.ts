import type { ProjectWorktree } from '@entities/ProjectGit';

export interface WorktreeBootstrapCardProps {
  /** Основная копия — по ней ходят запросы списка и лога. */
  path: string;
  worktree: ProjectWorktree;
  /** Идёт другая операция раздела — повтор тоже ждёт. */
  disabled: boolean;
  onRerun: () => void;
}
