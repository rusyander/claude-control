import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, GroupMember } from '@agentdeck/contracts';
import type { DiscoveredGroup, DiscoveryView } from '@agentdeck/contracts/group-sources';
import { IMPORTABLE_MEMBER_KINDS, scopeOf } from '@agentdeck/contracts/group-sources';
import {
  projectKey,
  readGroupSources,
  updateGroupSources,
  type GroupSourcesState,
} from '../../lib/app-store/group-sources.ts';
import type { AppStore } from '../../lib/app-store.ts';
import { readTextFile } from '../../lib/safe-io.ts';
import { GroupRequestError } from '../groups/errors.ts';
import { usedInOf } from '../groups/views.ts';
import { readDiscoveryCache } from './run.ts';
import type { DiscoverySpec } from './sources.ts';

/**
 * Находка → проектная группа, и что к находке досчитывается при показе:
 * статус («импортирован», «есть глобальная копия») и где набор используется.
 */

/** Виды находки, которые бывают участниками группы. Агенты, команды и инструкции — нет (вопрос владельцу). */
const MEMBER_KINDS = new Set<string>(IMPORTABLE_MEMBER_KINDS);

/** Слово-идентификатор короче этого слишком часто встречается в тексте случайно. */
const MIN_REFERENCE_ID = 4;

/** Тексты проекта, по которым ищутся ссылки на предметы набора. */
function projectTexts(root: string): string {
  const files = [join(root, 'CLAUDE.md'), join(root, 'AGENTS.md')];
  return files
    .filter((file) => existsSync(file))
    .map((file) => {
      try {
        return readTextFile(file).slice(0, 200_000);
      } catch {
        return '';
      }
    })
    .join('\n');
}

function referenced(text: string, id: string): boolean {
  if (id.length < MIN_REFERENCE_ID) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

/**
 * Где набор используется: проект, где его нашли; проекты, чьи CLAUDE.md /
 * AGENTS.md называют его скилл; привязки и выбор группы, заведённой из него.
 */
export function discoveredUsedIn(
  found: DiscoveredGroup,
  projects: readonly DiscoverySpec[],
  imported: Group | undefined,
  choices: GroupSourcesState['choices'],
  texts: Map<string, string>,
): string[] {
  const seen = new Map<string, string>();
  const add = (path: string): void => {
    const key = projectKey(path);
    if (!seen.has(key)) seen.set(key, path);
  };
  if (!found.foundIn.startsWith('provider:')) add(found.foundIn);
  const ids = found.members.filter((member) => member.kind === 'skill').map((member) => member.id);
  for (const project of projects) {
    if (project.kind !== 'project') continue;
    let text = texts.get(project.root);
    if (text === undefined) {
      text = projectTexts(project.root);
      texts.set(project.root, text);
    }
    if (ids.some((id) => referenced(text!, id))) add(project.root);
  }
  if (imported) for (const path of usedInOf(imported, choices)) add(path);
  return [...seen.values()];
}

/** Вид обнаружения с досчитанными статусами и `usedIn`. */
export function decorateDiscovery(
  view: DiscoveryView,
  groups: readonly Group[],
  appData: string,
  specs: readonly DiscoverySpec[],
): DiscoveryView {
  const state = readGroupSources(appData);
  const texts = new Map<string, string>();
  return {
    ...view,
    groups: view.groups.map((found) => {
      const importedId = state.imported[found.key];
      const imported = groups.find((group) => group.id === importedId);
      const copied =
        imported !== undefined && groups.some((group) => group.origin?.groupId === imported.id);
      const status: DiscoveredGroup['status'] = copied ? 'copied' : imported ? 'imported' : 'new';
      return {
        ...found,
        status,
        usedIn: discoveredUsedIn(found, specs, imported, state.choices, texts),
      };
    }),
  };
}

/** Находка по ключу из кэша. */
export function findDiscovered(appData: string, key: string): DiscoveredGroup | undefined {
  for (const entry of Object.values(readDiscoveryCache(appData).sources)) {
    const found = entry.groups.find((group) => group.key === key);
    if (found) return found;
  }
  return undefined;
}

/**
 * Импорт находки: проектная группа, указывающая на файлы проекта. Сам
 * репозиторий не трогается — запись панели только называет его файлы.
 * Повторный импорт той же находки возвращает уже заведённую группу.
 */
export function importDiscovered(
  appData: string,
  store: AppStore,
  key: string,
  makeId: () => string = randomUUID,
  lang?: 'ru' | 'en',
): Group {
  const found = findDiscovered(appData, key);
  if (!found) {
    throw new GroupRequestError(404, 'discovery_not_found', 'group-discovery-not-found');
  }
  if (found.foundIn.startsWith('provider:')) {
    throw new GroupRequestError(
      409,
      'discovery_provider_source',
      'group-discovery-provider-source',
    );
  }

  const groups = store.getGroups();
  const already = groups.find((group) => group.id === readGroupSources(appData).imported[key]);
  if (already) return already;

  const scope = { kind: 'project' as const, path: found.foundIn, provider: 'claude' };
  const members: GroupMember[] = found.members
    .filter((member) => MEMBER_KINDS.has(member.kind))
    .map((member) => ({ kind: member.kind as GroupMember['kind'], id: member.id, scope }));

  // Имя и «Когда» — на языке интерфейса, из которого импортировали; у
  // находки старого вида второго языка нет — берётся то, что есть.
  const name = (lang && found.localized?.name[lang]) || found.name;
  const when = (lang && found.localized?.when[lang]) || found.when;
  const group: Group = {
    id: makeId(),
    name,
    // `why` находки — английская фраза модели о том, почему файлы — набор; в
    // описание группы она не идёт: описание пишет человек, а английский абзац
    // наверху «Состава» в русском интерфейсе был жалобой.
    description: '',
    color: 'accent',
    icon: 'folder',
    members,
    env: {},
    projectPaths: [],
    scope,
    ...(when ? { when } : {}),
    // Импорт группу не включает: никто этого не просил, наброски агента тоже
    // рождаются выключенными. Сохранение — прямое, без удержания участников:
    // файлы проекта не трогаются, пока человек сам её не включит.
    isEnabled: false,
    order: groups.reduce((max, item) => Math.max(max, item.order), -1) + 1,
  };
  const saved = store.saveGroup(group);
  updateGroupSources(appData, (state) => {
    state.imported[key] = saved.id;
  });
  return saved;
}

/** Проектная ли группа (для маршрутов, которым нужна именно она). */
export function isProjectGroup(group: Group): boolean {
  return scopeOf(group).kind === 'project';
}
