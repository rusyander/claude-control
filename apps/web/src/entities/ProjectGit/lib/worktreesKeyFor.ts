import { projectGitKey } from '../api/ProjectGitApi.constants';
import { normalizeProjectPath } from '@shared/lib/workspace';

/** Ключ кэша списка копий — свой, чтобы состояние репозитория не перезапрашивалось зря. */
export function worktreesKeyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, 'worktrees', path ? normalizeProjectPath(path) : ''];
}
