import type { ProjectTestEnvironment } from '@agentdeck/contracts';

/**
 * Живые окружения: архивные уезжают вниз, а не исчезают.
 *
 * Убранное в архив окружение продолжает называться в старых прогонах, и прятать
 * его совсем значило бы оставить в истории ссылку на «неизвестно что».
 */
export function sortEnvironments(items: ProjectTestEnvironment[]): ProjectTestEnvironment[] {
  return [...items].sort((left, right) => {
    if (Boolean(left.archived) !== Boolean(right.archived)) return left.archived ? 1 : -1;
    if (Boolean(left.isDefault) !== Boolean(right.isDefault)) return left.isDefault ? -1 : 1;
    return left.title.localeCompare(right.title, 'ru');
  });
}
