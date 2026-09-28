import { normalizeProjectPath } from '@shared/lib/workspace';

/** Что показать на месте выбора проекта. */
export type TestsProjectState = 'loading' | 'error' | 'empty' | 'ready';

/**
 * Состояние раздела тестов до выбора проекта.
 *
 * Ошибка загрузки реестра — не пустой реестр: «проектов нет» советует добавить
 * проект, которого на самом деле хватает, и человек заводит его второй раз.
 * Если же при упавшем реестре есть открытые вкладки проектов, раздел работает
 * по ним — ошибку тогда показывают строкой над ним, а не вместо него.
 */
export function testsProjectState(input: {
  isLoading: boolean;
  isError: boolean;
  count: number;
}): TestsProjectState {
  if (input.isLoading) return 'loading';
  if (input.count > 0) return 'ready';
  return input.isError ? 'error' : 'empty';
}

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
