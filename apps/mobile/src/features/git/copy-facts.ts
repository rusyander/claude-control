import type { ProjectWorktree, ProjectWorktreesInfo } from '@agentdeck/contracts';

/**
 * Что показывать в списке копий. Основная копия — сам репозиторий: её состояние
 * уже целиком в пульте git, и строкой «копия полная» о ней сказать нечего —
 * сверяться ей не с чем.
 */
export function visibleCopies(info: ProjectWorktreesInfo | undefined): ProjectWorktree[] {
  if (!info?.isRepo) return [];
  return info.worktrees.filter((worktree) => !worktree.isMain);
}
