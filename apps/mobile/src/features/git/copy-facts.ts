import type { ProjectWorktree, ProjectWorktreesInfo } from '@agentdeck/contracts';
import type { Dictionary } from '../../shared/config/i18n';

/**
 * Что показывать в списке копий. Основная копия — сам репозиторий: её состояние
 * уже целиком в пульте git, и строкой «копия полная» о ней сказать нечего —
 * сверяться ей не с чем.
 */
export function visibleCopies(info: ProjectWorktreesInfo | undefined): ProjectWorktree[] {
  if (!info?.isRepo) return [];
  return info.worktrees.filter((worktree) => !worktree.isMain);
}

/**
 * Состояние копии словами. Запись доступа названа ВСЕГДА, а не только когда её
 * нет: «не сверялось» и «записи нет» — разные вещи, и первое чинить нечем, так
 * что человек, увидевший вместо него «нет записи», пошёл бы жать «Добрать» до
 * посинения.
 */
export function copyFacts(worktree: ProjectWorktree, t: Dictionary): string[] {
  const parts: string[] = [];
  if (worktree.head) parts.push(worktree.head);
  if (worktree.locked) parts.push(t.worktrees.locked);
  if (worktree.prunable) parts.push(t.worktrees.prunable);
  if (worktree.copy) parts.push(t.worktrees.access[worktree.copy.access]);
  return parts;
}
