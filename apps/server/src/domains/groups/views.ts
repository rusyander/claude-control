import type { Group } from '@agentdeck/contracts';
import type { GroupView } from '@agentdeck/contracts';
import { groupKeyOf, scopeOf, type StoredProjectChoice } from '@agentdeck/contracts/group-sources';
import { projectKey, readGroupSources } from '../../lib/app-store/group-sources.ts';
import type { EntityToggleDeps } from '../entity-toggle.ts';
import { memberContent, memberHashes, parseMemberKey } from './members.ts';

/**
 * Группа глазами страницы: запись плюс то, что досчитывается при чтении и не
 * хранится. Хранить `usedIn` и `originChanged` нельзя: первое меняют выбор
 * проекта и привязки, второе — чужой репозиторий, о правках которого панель
 * узнаёт, только перечитав его файлы.
 */

/** Проекты, где группа действует: привязка, выбор проекта, свой проект. */
export function usedInOf(group: Group, choices: Record<string, StoredProjectChoice>): string[] {
  const seen = new Map<string, string>();
  const add = (path: string): void => {
    const key = projectKey(path);
    if (!seen.has(key)) seen.set(key, path);
  };
  for (const path of group.projectPaths ?? []) add(path);
  const scope = scopeOf(group);
  if (scope.kind === 'project') add(scope.path);
  const own = groupKeyOf(group);
  for (const [path, stored] of Object.entries(choices)) {
    // Строка — запись v1 (один слот на проект), карта — выбор по парам.
    const keys = typeof stored === 'string' ? [stored] : Object.values(stored);
    if (keys.includes(own)) add(path);
  }
  return [...seen.values()];
}

/**
 * Участники оригинала, чьё содержимое с копирования сменилось, плюс новые в
 * нём. У копии без поштучных хэшей (старше поля) сравнивается общий хэш, и
 * при расхождении называются все — сказать точнее нечем.
 */
export function originChangedOf(
  deps: EntityToggleDeps,
  groups: readonly Group[],
  group: Group,
): string[] {
  const origin = group.origin;
  if (!origin) return [];
  const original = groups.find((item) => item.id === origin.groupId);
  const members =
    original?.members ??
    Object.keys(origin.memberHashes ?? {})
      .map(parseMemberKey)
      .filter((item): item is { kind: string; id: string } => item !== undefined)
      .map((item) => ({ ...item, kind: item.kind as Group['members'][number]['kind'] }));
  const now = memberHashes(deps, { scope: origin.scope, members });

  // Не прочёлся (файл заблокирован) — неизвестно, а не «изменился»: общий хэш
  // без него не сравнить, а поштучно он просто не называется.
  const unknown = new Set(now.unreadable);
  if (!origin.memberHashes) {
    if (unknown.size > 0) return [];
    return now.hash === origin.hash ? [] : Object.keys(now.hashes);
  }
  const changed: string[] = [];
  for (const [key, hash] of Object.entries(now.hashes)) {
    if (origin.memberHashes[key] !== hash) changed.push(key);
  }
  // Удалённый в проекте участник — тоже изменение: копия его ещё несёт.
  for (const key of Object.keys(origin.memberHashes)) {
    if (!(key in now.hashes) && !unknown.has(key)) changed.push(key);
  }
  return changed;
}

export function groupViews(deps: EntityToggleDeps): GroupView[] {
  const groups = deps.store.getGroups();
  const { choices } = readGroupSources(deps.paths.appData);
  return groups.map((group) => {
    const view: GroupView = { ...group, usedIn: usedInOf(group, choices) };
    if (group.origin) view.originChanged = originChangedOf(deps, groups, group);
    return view;
  });
}

/** Текст участника оригинала по ключу — для слияния. */
export function originText(deps: EntityToggleDeps, group: Group, key: string): string | undefined {
  const member = parseMemberKey(key);
  if (!group.origin || !member) return undefined;
  return memberContent(deps, group.origin.scope, member)?.text;
}
