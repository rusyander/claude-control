import { projectGitKey } from '../api/ProjectGitApi.constants';
import { normalizeProjectPath } from '@shared/lib/workspace';

/** Ключ шаблонов зеркала — по основной копии, как и сама запись в хранилище. */
export function mirrorSettingsKeyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, 'mirror-settings', path ? normalizeProjectPath(path) : ''];
}
