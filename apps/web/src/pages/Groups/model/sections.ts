import { inClaudeGlobals, scopeOf, type DiscoveryView } from '@agentdeck/contracts';
import type { GroupListItem } from '@entities/Group';
import type { GroupCardModel, GroupSections } from './sections.types';

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
