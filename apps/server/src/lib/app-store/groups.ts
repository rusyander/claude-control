import type { EntityKind, Group } from '@claude-control/contracts';
import type { AppState } from './app-store.types.ts';

export function listGroups(state: AppState): Group[] {
  return [...state.groups].sort((a, b) => a.order - b.order);
}

/**
 * Группы, в которые входит сущность — для отображения меток в списках.
 * `legacyId` сверяется тоже: состав групп записан до перехода хуков на
 * контентные идентификаторы, и иначе группа потеряла бы участников.
 */
export function groupIdsFor(
  state: AppState,
  kind: EntityKind,
  id: string,
  legacyId?: string,
): string[] {
  return state.groups
    .filter((group) =>
      group.members.some(
        (member) =>
          member.kind === kind && (member.id === id || (legacyId && member.id === legacyId)),
      ),
    )
    .map((group) => group.id);
}

export function saveGroup(state: AppState, group: Group): Group {
  const index = state.groups.findIndex((item) => item.id === group.id);
  if (index >= 0) state.groups[index] = group;
  else state.groups.push(group);
  return group;
}

export function deleteGroup(state: AppState, id: string): void {
  state.groups = state.groups.filter((group) => group.id !== id);
}

/** Какие ключи env применила группа (записала в settings.json). */
export function getGroupEnvKeys(state: AppState, groupId: string): string[] {
  return state.envByGroup[groupId] ?? [];
}

/** Запомнить/очистить набор ключей env, применённых группой. */
export function setGroupEnvKeys(state: AppState, groupId: string, keys: string[]): void {
  if (keys.length > 0) state.envByGroup[groupId] = [...keys];
  else delete state.envByGroup[groupId];
}

/** Держит ли этот ключ env хоть одна группа (кроме, если задано, `exceptId`). */
export function isEnvKeyOwnedByGroup(state: AppState, key: string, exceptId?: string): boolean {
  for (const [groupId, keys] of Object.entries(state.envByGroup)) {
    if (groupId === exceptId) continue;
    if (keys.includes(key)) return true;
  }
  return false;
}
