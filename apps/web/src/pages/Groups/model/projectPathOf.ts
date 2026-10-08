import type { GroupListItem } from '@entities/Group';
import { scopeOf } from '@agentdeck/contracts';

/** Путь проекта, в котором живёт проектная группа; у глобальной — нет. */
export function projectPathOf(group: GroupListItem): string | undefined {
  const scope = scopeOf(group);
  return scope.kind === 'project' ? scope.path : undefined;
}
