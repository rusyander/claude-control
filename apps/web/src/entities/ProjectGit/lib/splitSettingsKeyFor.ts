import { projectGitKey } from '../api/ProjectGitApi.constants';
import { normalizeProjectPath } from '@shared/lib/workspace';

/** Ключ настроек разделения — по основной копии, как и шаблоны зеркала. */
export function splitSettingsKeyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, 'split-settings', path ? normalizeProjectPath(path) : ''];
}
