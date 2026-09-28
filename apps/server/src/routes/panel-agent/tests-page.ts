import type { PanelPageTarget } from '@agentdeck/contracts/panel-agent';

/**
 * Страница тестов открывается на ТОМ проекте, с которым работал агент: раздел
 * помнит выбранный проект в браузере, и без `?project=` человек смотрел бы на
 * библиотеку другого проекта, пока агент докладывает о черновиках этого.
 */
export function testsPage(
  projectPath: string,
  tab?: 'library' | 'plans' | 'runs' | 'report' | 'coverage',
): PanelPageTarget {
  return {
    route: `/tests?project=${encodeURIComponent(projectPath)}`,
    ...(tab ? { focus: tab } : {}),
  };
}

/** Запрос `path=` раздела тестов: каталог проекта уходит в каждый маршрут. */
export const testsQuery = (path: string): string => `path=${encodeURIComponent(path)}`;
