import type { ProjectTestGroup } from '@agentdeck/contracts';

/**
 * Открытая группа: выбранная человеком, а если её не стало — первая.
 *
 * Группы может не стать: агент удалил файл, или окно открыли впервые. Пустой
 * экран без вкладок читается как «тестов нет», хотя они есть.
 */
export function pickActive(
  groups: ProjectTestGroup[],
  activeId: string,
): ProjectTestGroup | undefined {
  return groups.find((group) => group.id === activeId) ?? groups[0];
}
