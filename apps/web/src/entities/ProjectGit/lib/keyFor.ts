import { projectGitKey } from '../api/ProjectGitApi.constants';
import { normalizeProjectPath } from '@shared/lib/workspace';

/** Ключ кэша на проект — по нормализованному пути. */
export function keyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, path ? normalizeProjectPath(path) : ''];
}
