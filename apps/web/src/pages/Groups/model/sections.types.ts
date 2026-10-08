import type { GroupListItem } from '@entities/Group';
import type { DiscoveredGroup } from '@agentdeck/contracts';

/**
 * Карточка страницы групп. Связанная пара — глобальная копия и проектный
 * оригинал — ОДНА карточка: две рядом читались бы как две разные группы, хотя
 * в проекте действует ровно одна из них.
 */
export interface GroupCardModel {
  group: GroupListItem;
  /** Проектная сторона пары; есть только у глобальной копии, чей оригинал жив. */
  pair?: GroupListItem;
}

export interface GroupSections {
  global: GroupCardModel[];
  project: GroupCardModel[];
  /** Найдено, но ещё не стало группой. */
  discovered: DiscoveredGroup[];
}
