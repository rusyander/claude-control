import type { GroupSections } from './sections.types';
import type { GroupsTabId } from './tabs.types';

/**
 * Где на странице карточка группы: вкладка и id карточки. Проектная половина
 * пары своей карточки не имеет — её показывает карточка глобальной копии на
 * «Глобальных». Нужна переходу агента (`?show=<id>`): вкладка из памяти зрителя
 * могла быть другой, и подсветка молча не срабатывала.
 */
export function cardOf(
  sections: GroupSections,
  id: string,
): { tab: GroupsTabId; cardId: string } | undefined {
  const global = sections.global.find((card) => card.group.id === id || card.pair?.id === id);
  if (global) return { tab: 'global', cardId: global.group.id };
  const project = sections.project.find((card) => card.group.id === id);
  return project ? { tab: 'project', cardId: project.group.id } : undefined;
}
