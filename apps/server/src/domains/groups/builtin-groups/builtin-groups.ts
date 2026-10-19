import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { isBuiltinGroupId, type BuiltinGroupsStatus } from '@agentdeck/contracts/groups';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { BUILTIN_GROUPS } from './builtin-groups.constants.ts';
import type { BuiltinGroupEntry, BuiltinSeedReport } from './builtin-groups.types.ts';

/**
 * Встроенные группы доставки (владелец 20.10.2026): семь групп каталога,
 * засеваемых в КАЖДЫЙ каталог настроек на старте и при его смене.
 *
 * Правила прохода, по группе:
 * - удалена человеком → не трогаем, пока он не вернёт («Вернуть встроенные»);
 * - нет в группах → добавляем на языке интерфейса, в конец списка;
 * - есть и не тронута (отпечаток = записанному) → обновляем содержимое до
 *   текущего каталога, сохраняя включение, порядок, проекты и числа человека;
 * - есть и изменена человеком → не трогаем больше никогда;
 * - есть без записи (state.json перенесён) → совпадает с каталогом — принимаем
 *   как свою, иначе считаем изменённой.
 */
export interface BuiltinSeedDeps {
  store: AppStore;
  /** `~/.claude/skills` — есть ли там свой скилл, или шаг называет скилл набора. */
  skillsDir: string;
  now?: Date;
}

/** Набор панели подключается флагом запуска — его скиллы зовутся с префиксом. */
const KIT_PREFIX = 'agentdeck-kit:';

function skillIdFor(skillsDir: string, name: string): string {
  return existsSync(join(skillsDir, name, 'SKILL.md')) ? name : `${KIT_PREFIX}${name}`;
}

/** Содержимое группы — то, что задаёт каталог; остальное принадлежит человеку. */
function contentOf(group: Group): unknown {
  return {
    name: group.name,
    description: group.description,
    color: group.color,
    icon: group.icon,
    members: group.members,
    env: group.env,
    flow: group.flow ?? 'conveyor',
    when: group.when ?? '',
    steps: (group.path?.steps ?? []).map(({ createdAt: _createdAt, ...step }) => step),
  };
}

export function builtinContentHash(group: Group): string {
  return createHash('sha256')
    .update(JSON.stringify(contentOf(group)))
    .digest('hex')
    .slice(0, 16);
}

function render(
  entry: BuiltinGroupEntry,
  language: 'ru' | 'en',
  skillsDir: string,
  createdAt: string,
): Omit<Group, 'order' | 'isEnabled'> {
  return {
    id: entry.id,
    name: entry.name[language],
    description: entry.description[language],
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    flow: 'conveyor',
    when: entry.when,
    path: {
      steps: [
        {
          id: `${entry.id}:profile`,
          anchor: 'work',
          order: 0,
          within: { skillId: skillIdFor(skillsDir, entry.skill), index: -1, after: '' },
          kind: 'prompt',
          source: 'en',
          title: entry.step.title,
          prompt: entry.step.prompt,
          gate: entry.step.gate,
          createdAt,
        },
      ],
    },
  };
}

export function seedBuiltinGroups(deps: BuiltinSeedDeps): BuiltinSeedReport {
  const { store, skillsDir } = deps;
  const createdAt = (deps.now ?? new Date()).toISOString();
  const language = store.getSettings().language === 'en' ? 'en' : 'ru';
  const record = store.getBuiltinGroups();
  const seeded = { ...record.seeded };
  const removed = new Set(record.removed);
  const report: BuiltinSeedReport = { added: [], updated: [] };
  const groups = store.getGroups();
  // Встроенные встают ПОСЛЕ групп человека: каталог «Авто» режется по порядку
  // (40 строк), и встроенная не должна вытеснить из него свою группу.
  let nextOrder = Math.max(0, ...groups.map((group) => group.order + 1));

  for (const entry of BUILTIN_GROUPS) {
    if (removed.has(entry.id)) continue;
    const existing = groups.find((group) => group.id === entry.id);
    const fresh = render(entry, language, skillsDir, createdAt);
    const freshHash = builtinContentHash({ ...fresh, order: 0, isEnabled: true });

    if (!existing) {
      store.saveGroup({ ...fresh, isEnabled: true, order: nextOrder });
      nextOrder += 1;
      seeded[entry.id] = freshHash;
      report.added.push(entry.id);
      continue;
    }
    const current = builtinContentHash(existing);
    const recorded = seeded[entry.id];
    if (recorded === undefined) {
      if (current === freshHash) seeded[entry.id] = current;
      continue;
    }
    if (recorded !== current || current === freshHash) continue;
    // Не тронута человеком, а каталог (версия, язык, скилл) ушёл вперёд.
    const steps = fresh.path?.steps.map((step) => ({
      ...step,
      createdAt: existing.path?.steps.find((own) => own.id === step.id)?.createdAt ?? createdAt,
    }));
    store.saveGroup({ ...existing, ...fresh, path: { steps: steps ?? [] } });
    seeded[entry.id] = freshHash;
    report.updated.push(entry.id);
  }

  const changed =
    report.added.length > 0 ||
    report.updated.length > 0 ||
    Object.keys(seeded).length !== Object.keys(record.seeded).length;
  // Пустой проход state.json не переписывает: он идёт на каждом старте.
  if (changed) store.setBuiltinGroups({ seeded, removed: [...removed] });
  return report;
}

/** Человек удалил встроенную — сама она больше не вернётся. */
export function rememberBuiltinRemoved(store: AppStore, id: string): void {
  if (!isBuiltinGroupId(id)) return;
  const record = store.getBuiltinGroups();
  const seeded = { ...record.seeded };
  delete seeded[id];
  store.setBuiltinGroups({ seeded, removed: [...new Set([...record.removed, id])] });
}

/** «Вернуть встроенные»: снять отказ и засеять заново. Ответ — имена вернувшихся. */
export function restoreBuiltinGroups(deps: BuiltinSeedDeps): string[] {
  const record = deps.store.getBuiltinGroups();
  deps.store.setBuiltinGroups({ ...record, removed: [] });
  const { added } = seedBuiltinGroups(deps);
  const groups = deps.store.getGroups();
  return added.map((id) => groups.find((group) => group.id === id)?.name ?? id);
}

/** Что показать на странице групп: удалённые и изменённые человеком. */
export function builtinGroupsStatus(store: AppStore): BuiltinGroupsStatus {
  const record = store.getBuiltinGroups();
  const edited = store
    .getGroups()
    .filter((group) => isBuiltinGroupId(group.id))
    .filter((group) => {
      const recorded = record.seeded[group.id];
      return recorded === undefined || recorded !== builtinContentHash(group);
    })
    .map((group) => group.id);
  return {
    removed: record.removed.filter((id) => BUILTIN_GROUPS.some((e) => e.id === id)),
    edited,
  };
}
