import type { Project } from '@agentdeck/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Проект по каталогу: так его называет агент панели (`/tests?project=<путь>`).
 * Один каталог пишется по-разному — регистр и слэши не различаем.
 */
export function projectByPath(projects: Project[], path: string): Project | undefined {
  const wanted = normalizeProjectPath(path);
  return projects.find((project) => normalizeProjectPath(project.path) === wanted);
}
