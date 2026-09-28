import {
  inClaudeGlobals,
  scopeOf,
  type DiscoveredGroup,
  type DiscoveryView,
} from '@agentdeck/contracts';
import type { GroupListItem } from '@entities/Group';
import type { GroupsTabId } from './tabs';

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

/** Три раздела страницы: глобальные (с парами), проектные без пары, находки. */
export function buildSections(
  groups: GroupListItem[],
  discovery: DiscoveryView | undefined,
): GroupSections {
  const sorted = [...groups].sort((left, right) => left.order - right.order);
  const projectById = new Map(
    sorted.filter((group) => scopeOf(group).kind === 'project').map((group) => [group.id, group]),
  );
  const paired = new Set<string>();

  const global = sorted
    .filter((group) => scopeOf(group).kind === 'global')
    .map((group): GroupCardModel => {
      // Копия для другой CLI — не сторона пары: в проекте Claude её не берёт,
      // и переключатель пары выбирал бы группу без файлов у Claude.
      const pair =
        group.origin && inClaudeGlobals(group.scope)
          ? projectById.get(group.origin.groupId)
          : undefined;
      if (!pair) return { group };
      paired.add(pair.id);
      return { group, pair };
    });

  const project = [...projectById.values()]
    .filter((group) => !paired.has(group.id))
    .map((group) => ({ group }));

  return {
    global,
    project,
    discovered: (discovery?.groups ?? []).filter((found) => found.status === 'new'),
  };
}

/** Путь проекта, в котором живёт проектная группа; у глобальной — нет. */
export function projectPathOf(group: GroupListItem): string | undefined {
  const scope = scopeOf(group);
  return scope.kind === 'project' ? scope.path : undefined;
}

/**
 * «Найдено в»: у проектной группы — её проект, у глобальной копии — проект
 * оригинала. У группы, собранной руками в панели, места находки нет.
 */
export function foundInOf(group: GroupListItem): string | undefined {
  const own = projectPathOf(group);
  if (own) return own;
  const origin = group.origin?.scope;
  return origin && origin.kind === 'project' ? origin.path : undefined;
}

/** Строка источника обнаружения для человека: `provider:claude` → «общие каталоги claude». */
export function sourceLabel(source: string): { kind: 'provider' | 'project'; name: string } {
  return source.startsWith('provider:')
    ? { kind: 'provider', name: source.slice('provider:'.length) }
    : { kind: 'project', name: source };
}

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
