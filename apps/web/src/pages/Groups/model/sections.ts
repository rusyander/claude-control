import { inClaudeGlobals, scopeOf } from '@agentdeck/contracts';
import type { GroupListItem } from '@entities/Group';
import type { GroupCardModel, GroupSections } from './sections.types';

/** Два раздела сетки прежних групп: глобальные (с парами) и проектные без пары. */
export function buildSections(groups: GroupListItem[]): GroupSections {
  const sorted = [...groups].sort((left, right) => left.order - right.order);
  const projectById = new Map(
    sorted.filter((group) => scopeOf(group).kind === 'project').map((group) => [group.id, group]),
  );
  const paired = new Set<string>();

  const global = sorted
    .filter((group) => scopeOf(group).kind === 'global')
    .map((group): GroupCardModel => {
      // Копия для другой CLI — не сторона пары: в проекте Claude её не берёт.
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

  return { global, project };
}
