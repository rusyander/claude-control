import type { Project } from '@agentdeck/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Реестр плюс открытые вкладки проектов.
 *
 * Реестр — канонический список, но человек может работать во вкладке проекта,
 * ни разу его туда не добавив: тогда панель проект ЗНАЕТ, а раздел тестов
 * показывал бы «проектов нет» — тупик на ровном месте. Вкладки дописываются
 * после реестра и только те, которых в нём ещё нет.
 */
export function mergeProjects(registry: Project[], tabs: Project[]): Project[] {
  const known = new Set(registry.map((project) => normalizeProjectPath(project.path)));
  return [...registry, ...tabs.filter((tab) => !known.has(normalizeProjectPath(tab.path)))];
}
