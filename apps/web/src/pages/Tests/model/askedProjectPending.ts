import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Каталог из `?project=` ни найден, ни назван пропавшим: реестр грузится или
 * упал, а среди открытых вкладок его нет. Раздел при этом показывает другой
 * проект — и должен сказать об этом, а не молчать (F-303).
 */
export function askedProjectPending(
  projects: readonly { path: string }[],
  askedPath: string | undefined,
  registry: { isLoading: boolean; isError: boolean },
): boolean {
  if (!askedPath || !(registry.isLoading || registry.isError)) return false;
  const wanted = normalizeProjectPath(askedPath);
  return !projects.some((project) => normalizeProjectPath(project.path) === wanted);
}
