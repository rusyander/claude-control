import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, GroupMember, Hook, McpServerDraft } from '@agentdeck/contracts';
import type { GroupPath } from '@agentdeck/contracts/group-path';
import type { CopyWarning, GroupScope } from '@agentdeck/contracts/group-sources';
import { groupKeyOf, scopeOf } from '@agentdeck/contracts/group-sources';
import { updateGroupSources, projectKey } from '../../lib/app-store/group-sources.ts';
import { hookContentId } from '../../lib/hook-id.ts';
import { copyRecursive } from '../../lib/safe-io.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import type { EntityToggleDeps } from '../entity-toggle.ts';
import { readHooks, writeHooks } from '../hooks.ts';
import { saveMcpServer } from '../mcp.ts';
import { freeRuleTitle, readRules, ruleByTitle, saveRule } from '../rules.ts';
import { disabledSkillsDir } from '../skills/paths.ts';
import { assertNotCopied, pairsIn, withPairChoice } from './choice.ts';
import { GroupRequestError } from './errors.ts';
import { carriedKnobs, seedCopiedKnobs } from './knobs.ts';
import {
  hashDir,
  memberContent,
  memberHashes,
  memberKey,
  memberScope,
  skillDirFor,
  type MemberContent,
} from './members.ts';

/**
 * Копия проектной группы в глобальные каталоги — через те же писатели, что у
 * страниц сущностей (скилл — каталогом, правило — разделом CLAUDE.md, хук —
 * `writeHooks`, MCP — `saveMcpServer`), каждый со своей копией до записи.
 *
 * Проект не трогается: копия пишет только в общие каталоги. Имя занято — берётся
 * суффикс, и карточка называет это предупреждением; то же содержимое уже есть —
 * берётся существующее, а не заводится второе.
 */

export interface CopiedMember {
  /** Участник оригинала. */
  from: GroupMember;
  /** Участник копии (глобальный id). */
  to: GroupMember;
  content: MemberContent;
  /** Совпадающий общий ресурс взят как есть: он жил до копии, копия его не создавала. */
  reused?: boolean;
}

export interface CopyOutcome {
  group: Group;
  warnings: CopyWarning[];
  copied: CopiedMember[];
}

/** Свободное имя: `id`, затем `id-<проект>`, затем с номером. */
function freeName(taken: (id: string) => boolean, id: string, project: string): string {
  if (!taken(id)) return id;
  const base = `${id}-${project}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

function projectSlug(scope: GroupScope): string {
  if (scope.kind !== 'project') return 'project';
  const parts = scope.path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'project';
}

/** Имя скилла в шапке — вслед за каталогом, иначе у двух скиллов было бы одно `name`. */
function renameSkillHeader(dir: string, id: string): void {
  const file = join(dir, 'SKILL.md');
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/^(---\r?\n[\s\S]*?^name:)[^\r\n]*/m, `$1 ${id}`);
  if (next !== text) writeFileSync(file, next, 'utf8');
}

function copySkill(
  deps: EntityToggleDeps,
  content: MemberContent,
  project: string,
  warnings: CopyWarning[],
): string {
  const { skills } = deps.paths;
  const existing = skillDirFor(deps.paths, { kind: 'global' }, content.id);
  if (existing && hashDir(existing) === content.hash) return content.id;
  const taken = (id: string): boolean =>
    existsSync(join(skills, id)) || existsSync(join(disabledSkillsDir(skills), id));
  const id = freeName(taken, content.id, project);
  copyRecursive(content.path, join(skills, id));
  if (id !== content.id) {
    renameSkillHeader(join(skills, id), id);
    warnings.push({ kind: 'renamed', member: memberKey(content), to: id, detail: '' });
  }
  return id;
}

/** Текст правила-файла → заголовок и тело раздела CLAUDE.md. */
export function ruleDraftOf(id: string, text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line));
  if (at < 0) return { title: id, body: text.trim() };
  return {
    title: lines[at]!.replace(/^#{1,6}\s+/, '').trim(),
    body: [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').trim(),
  };
}

function copyRule(deps: EntityToggleDeps, content: MemberContent, warnings: CopyWarning[]): string {
  const { title, body } = ruleDraftOf(content.id, content.text);
  const rules = readRules(deps.paths.claudeMd, deps.store);
  const same = rules.find((rule) => rule.title === title && rule.body.trim() === body);
  if (same) return same.id;
  // Одноимённое общее правило с другим телом: копия ложится под «Название (2)»,
  // а не тёзкой — тёзка сдвигал id соседей и уводил участников чужих групп.
  const free = freeRuleTitle(rules, title);
  saveRule(
    deps.paths.claudeMd,
    '',
    { title: free, body, isEnabled: true, groupIds: [] },
    deps.store,
    deps.backupDir,
  );
  const id = ruleByTitle(readRules(deps.paths.claudeMd, deps.store), free)?.id ?? content.id;
  if (free !== title) {
    warnings.push({ kind: 'renamed', member: memberKey(content), to: free, detail: '' });
  }
  return id;
}

/** Хук с путём относительно проекта в общих настройках срабатывал бы везде — без своего скрипта. */
const PROJECT_RELATIVE = /CLAUDE_PROJECT_DIR|(^|[\s"'])\.claude[\\/]/;

function copyHook(
  deps: EntityToggleDeps,
  content: MemberContent,
  warnings: CopyWarning[],
): string | undefined {
  const raw = JSON.parse(content.text) as {
    event: Hook['event'];
    matcher?: string;
    command: string;
  };
  if (PROJECT_RELATIVE.test(raw.command)) {
    warnings.push({ kind: 'skipped', member: memberKey(content), detail: 'project-relative' });
    return undefined;
  }
  const id = hookContentId(raw.event, raw.matcher, raw.command);
  const hooks = readHooks(deps.paths.settings, deps.store);
  if (hooks.some((hook) => hook.id === id)) return id;
  const hook: Hook = {
    id,
    event: raw.event,
    ...(raw.matcher ? { matcher: raw.matcher } : {}),
    command: raw.command,
    isEnabled: true,
    groupIds: [],
    source: 'settings',
  };
  writeHooks(deps.paths.settings, [...hooks, hook], deps.backupDir);
  return id;
}

function mcpDraftOf(name: string, raw: Record<string, unknown>): McpServerDraft {
  const url = typeof raw.url === 'string' ? raw.url : undefined;
  const type =
    raw.type === 'sse' || raw.type === 'http' || raw.type === 'stdio' ? raw.type : undefined;
  const strings = (value: unknown): Record<string, string> =>
    value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
      : {};
  return {
    name,
    transport: type ?? (url ? 'http' : 'stdio'),
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    ...(url ? { url } : {}),
    env: strings(raw.env),
    headers: strings(raw.headers),
    groupIds: [],
  };
}

function copyMcp(
  deps: EntityToggleDeps,
  content: MemberContent,
  project: string,
  warnings: CopyWarning[],
): string | undefined {
  const global = memberContent(deps, { kind: 'global' }, { kind: 'mcp', id: content.id });
  if (global && global.hash === content.hash) return content.id;
  const raw = JSON.parse(content.text) as Record<string, unknown>;
  const taken = (id: string): boolean =>
    memberContent(deps, { kind: 'global' }, { kind: 'mcp', id }) !== undefined;
  const id = freeName(taken, content.id, project);
  saveMcpServer(deps.paths.mcpConfig, null, mcpDraftOf(id, raw), deps.backupDir);
  if (id !== content.id)
    warnings.push({ kind: 'renamed', member: memberKey(content), to: id, detail: '' });
  return id;
}

/** Скопировать одного участника в глобальные каталоги Claude; `undefined` — не перенесён. */
function copyMember(
  deps: EntityToggleDeps,
  content: MemberContent,
  project: string,
  warnings: CopyWarning[],
): string | undefined {
  // Сбой одного участника — предупреждение, а не обрыв: записанные до него уже
  // лежат в общих, и без сохранённой группы остались бы ничьими.
  try {
    if (content.kind === 'skill') return copySkill(deps, content, project, warnings);
    if (content.kind === 'rule') return copyRule(deps, content, warnings);
    if (content.kind === 'hook') return copyHook(deps, content, warnings);
    if (content.kind === 'mcp') return copyMcp(deps, content, project, warnings);
  } catch (error) {
    warnings.push({
      kind: 'failed',
      member: memberKey(content),
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  warnings.push({ kind: 'skipped', member: memberKey(content), detail: content.kind });
  return undefined;
}

/**
 * Скопировать проектную группу в глобальные каталоги Claude. Итог — новая
 * глобальная группа с `origin` (хэши участников оригинала), основа слияния в
 * `bases`, и выбор проекта переключён на копию: человек копирует ровно затем,
 * чтобы дальше работать ей.
 */
export function copyGroupToGlobal(
  deps: EntityToggleDeps,
  source: Group,
  now: string = new Date().toISOString(),
  makeId: () => string = randomUUID,
): CopyOutcome {
  const scope = scopeOf(source);
  if (scope.kind !== 'project') {
    throw new GroupRequestError(409, 'group_not_project', 'group-not-project');
  }
  assertNotCopied(deps.store.getGroups(), source);
  const project = projectSlug(scope);
  const warnings: CopyWarning[] = [];
  const copied: CopiedMember[] = [];
  const members: GroupMember[] = [];

  for (const member of source.members) {
    if (member.kind === 'group' || member.kind === 'permission') {
      warnings.push({ kind: 'skipped', member: memberKey(member), detail: member.kind });
      continue;
    }
    const content = memberContent(deps, memberScope(source, member), member);
    if (!content) {
      warnings.push({ kind: 'failed', member: memberKey(member), detail: 'missing' });
      continue;
    }
    const existed = Boolean(
      memberContent(deps, { kind: 'global' }, { kind: member.kind, id: content.id }),
    );
    const id = copyMember(deps, content, project, warnings);
    if (!id) continue;
    const to: GroupMember = { kind: member.kind, id };
    members.push(to);
    copied.push({
      from: member,
      to,
      content,
      ...(existed && id === content.id ? { reused: true } : {}),
    });
  }

  // Числа группы едут за скиллами: переименованный копией — под новым id.
  const skills = new Map(
    copied.filter((item) => item.from.kind === 'skill').map((item) => [item.from.id, item.to.id]),
  );
  const knobs = carriedKnobs(source.knobs, skills);
  const path = source.path ? carriedPath(source.path, copied) : undefined;
  const { hashes, hash } = memberHashes(deps, source);
  const group: Group = {
    id: makeId(),
    name: source.name,
    description: source.description,
    color: source.color,
    icon: source.icon,
    members,
    env: {},
    projectPaths: [],
    scope: { kind: 'global' },
    origin: { scope, groupId: source.id, hash, memberHashes: hashes, copiedAt: now },
    ...(path ? { path } : {}),
    ...(source.flow ? { flow: source.flow } : {}),
    ...(source.when ? { when: source.when } : {}),
    ...(knobs ? { knobs } : {}),
    isEnabled: true,
    order: deps.store.getGroups().reduce((max, item) => Math.max(max, item.order), -1) + 1,
  };
  const saved = deps.store.saveGroup(group);
  for (const [from, to] of skills) {
    seedCopiedKnobs(deps, { scope, skillId: from }, { scope: { kind: 'global' }, skillId: to });
  }

  updateGroupSources(deps.paths.appData, (state) => {
    state.bases[saved.id] = Object.fromEntries(
      copied.map((item) => [
        memberKey(item.from),
        {
          to: memberKey(item.to),
          // Основа слияния читается только моделью: секреты — маской.
          text: maskSecretsInText(item.content.text),
          ...(item.reused ? { reused: true } : {}),
        },
      ]),
    );
    // Выбор ставится только ЭТОЙ паре: выбор других пар проекта остаётся (F-113).
    const pairs = pairsIn(deps.store.getGroups(), scope.path);
    const pair = pairs.find((item) => item.project.id === source.id);
    const key = projectKey(scope.path);
    if (pair)
      state.choices[key] = withPairChoice(state.choices[key], pairs, pair, groupKeyOf(saved));
  });

  return { group: saved, warnings, copied };
}

/**
 * Путь едет за участниками: скилл, хук или правило, переименованные копией из-за
 * одноимённого общего, иначе оставили бы шаги копии на ЧУЖОМ общем ресурсе.
 */
function carriedPath(path: GroupPath, copied: readonly CopiedMember[]): GroupPath {
  const renamed = new Map(
    copied
      .filter((item) => item.from.id !== item.to.id)
      .map((item) => [`${item.from.kind}:${item.from.id}`, item.to.id]),
  );
  if (renamed.size === 0) return path;
  return {
    ...path,
    steps: path.steps.map((step) => {
      const skillId = step.within && renamed.get(`skill:${step.within.skillId}`);
      const resourceId = step.resource && renamed.get(`${step.resource.type}:${step.resource.id}`);
      return {
        ...step,
        ...(step.within && skillId ? { within: { ...step.within, skillId } } : {}),
        ...(step.resource && resourceId ? { resource: { ...step.resource, id: resourceId } } : {}),
      };
    }),
  };
}
