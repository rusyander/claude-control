import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Каталог из `?project=` не нашёлся среди известных проектов.
 *
 * Судить можно только по загруженному реестру: пока он грузится или упал,
 * «не найден» было бы неправдой — проект, может быть, как раз там.
 */
export function askedProjectMissing(
  projects: readonly { path: string }[],
  askedPath: string | undefined,
  registry: { isLoading: boolean; isError: boolean },
): boolean {
  if (!askedPath || registry.isLoading || registry.isError) return false;
  const wanted = normalizeProjectPath(askedPath);
  return !projects.some((project) => normalizeProjectPath(project.path) === wanted);
}
