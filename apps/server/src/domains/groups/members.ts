import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ClaudePaths, Group, GroupMember } from '@agentdeck/contracts';
import type { GroupScope } from '@agentdeck/contracts/group-sources';
import { readJsonFile, readTextFile } from '../../lib/safe-io.ts';
import type { AppStore } from '../../lib/app-store.ts';
import { readHooks, readHooksFromFiles } from '../hooks.ts';
import { readRules } from '../rules.ts';
import { safeSegment } from '../resources/registry.ts';
import { disabledSkillsDir } from '../skills/paths.ts';

/**
 * Содержимое участника группы там, где он живёт: в общих каталогах или в
 * `.claude` проекта. Нужно трём вещам сразу — хэшу (что в оригинале ушло
 * вперёд), советам и слиянию (модели показывается текст), копированию.
 *
 * Раскладка проекта — Claude'овская (`.claude/skills`, `.claude/rules/*.md`,
 * `.claude/settings.json`, `.mcp.json`): чужие раскладки проектов обнаружение
 * пока не описывает, и выдумывать их здесь значило бы хэшировать не те файлы.
 */

export interface MemberContent {
  kind: GroupMember['kind'];
  id: string;
  /** Файл (или каталог скилла), где участник лежит. */
  path: string;
  /** Текст для модели: SKILL.md, текст правила, запись хука/MCP в JSON. */
  text: string;
  /** Хэш содержимого; у скилла — всего каталога, не только SKILL.md. */
  hash: string;
}

export interface MemberDeps {
  paths: ClaudePaths;
  store: AppStore;
}

/** Ключ участника в `origin.memberHashes` и в строках «изменилось». */
export function memberKey(member: { kind: string; id: string }): string {
  return `${member.kind}:${member.id}`;
}

export function parseMemberKey(key: string): { kind: string; id: string } | undefined {
  const at = key.indexOf(':');
  if (at <= 0) return undefined;
  return { kind: key.slice(0, at), id: key.slice(at + 1) };
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Каталог `.claude` проекта. */
export function projectClaudeDir(root: string): string {
  return join(root, '.claude');
}

/**
 * Хэш каталога: относительные пути по порядку и байты каждого файла. EOL не
 * нормализуется — копия, отличающаяся только концами строк, и есть другая копия.
 *
 * Список групп считает хэш каждого участника каждой копии на КАЖДЫЙ запрос
 * (F-234: 30 копий × 20 участников — 0,4–1,5 с на запрос, почти всё — чтение
 * файлов). Поэтому байты читаются, только когда отпечаток каталога (пути,
 * размеры, время правки и номер файла) сменился; сам обход остаётся — без него
 * правку не заметить. Формула хэша прежняя: он записан в `origin.memberHashes`.
 */
const dirHashes = new Map<string, { stamp: string; hash: string }>();
const DIR_HASH_CACHE_MAX = 2_000;

export function hashDir(dir: string): string {
  // Ссылка на каталог выше (симлинк или junction на `..`) уводила обход в петлю
  // до переполнения стека, и участник читался как пропавший. Каталог, уже
  // пройденный по настоящему пути, второй раз не обходится. Настоящий путь
  // спрашивается у системы только у корня и у ссылок: у обычного подкаталога он
  // — настоящий путь родителя плюс имя, а realpath на каждый каталог был
  // главной ценой обхода на Windows.
  const seen = new Set<string>();
  const files: string[] = [];
  const stamp: string[] = [];
  const walk = (current: string, real: string): void => {
    if (seen.has(real)) return;
    seen.add(real);
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, join(real, entry.name));
        continue;
      }
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, realpathSync.native(full));
      else {
        files.push(full);
        stamp.push(`${full}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`);
      }
    }
  };
  walk(dir, realpathSync.native(dir));
  const key = stamp.join('\n');
  const cached = dirHashes.get(dir);
  if (cached?.stamp === key) return cached.hash;

  const hash = createHash('sha256');
  for (const full of files) {
    hash.update(relative(dir, full).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(full));
    hash.update('\0');
  }
  const digest = hash.digest('hex').slice(0, 16);
  if (dirHashes.size >= DIR_HASH_CACHE_MAX) dirHashes.delete(dirHashes.keys().next().value!);
  dirHashes.set(dir, { stamp: key, hash: digest });
  return digest;
}

/** Каталог скилла: у проекта — в его `.claude`, у общих — включённый или выключенный. */
export function skillDirFor(paths: ClaudePaths, scope: GroupScope, id: string): string | undefined {
  const candidates =
    scope.kind === 'project'
      ? [join(projectClaudeDir(scope.path), 'skills', id)]
      : [join(paths.skills, id), join(disabledSkillsDir(paths.skills), id)];
  return candidates.find((dir) => existsSync(join(dir, 'SKILL.md')));
}

function skillContent(
  paths: ClaudePaths,
  scope: GroupScope,
  id: string,
): MemberContent | undefined {
  const dir = skillDirFor(paths, scope, id);
  if (!dir) return undefined;
  return {
    kind: 'skill',
    id,
    path: dir,
    text: readTextFile(join(dir, 'SKILL.md')),
    hash: hashDir(dir),
  };
}

function ruleContent(deps: MemberDeps, scope: GroupScope, id: string): MemberContent | undefined {
  if (scope.kind === 'project') {
    const file = join(projectClaudeDir(scope.path), 'rules', `${id}.md`);
    if (!existsSync(file)) return undefined;
    const text = readTextFile(file);
    return { kind: 'rule', id, path: file, text, hash: hashText(text) };
  }
  const rule = readRules(deps.paths.claudeMd, deps.store).find((item) => item.id === id);
  if (!rule) return undefined;
  const text = `## ${rule.title}\n\n${rule.body.trim()}\n`;
  return { kind: 'rule', id, path: deps.paths.claudeMd, text, hash: hashText(text) };
}

function hookContent(deps: MemberDeps, scope: GroupScope, id: string): MemberContent | undefined {
  const root = scope.kind === 'project' ? scope.path : undefined;
  const dir = root ? projectClaudeDir(root) : undefined;
  const hooks = dir
    ? readHooksFromFiles(join(dir, 'settings.json'), join(dir, 'settings.local.json'), root)
    : readHooks(deps.paths.settings, deps.store);
  const hook = hooks.find((item) => item.id === id);
  if (!hook) return undefined;
  const text = JSON.stringify(
    { event: hook.event, matcher: hook.matcher, command: hook.command },
    null,
    2,
  );
  return {
    kind: 'hook',
    id,
    path: dir ? join(dir, 'settings.json') : deps.paths.settings,
    text,
    hash: hashText(text),
  };
}

function mcpContent(paths: ClaudePaths, scope: GroupScope, id: string): MemberContent | undefined {
  const file = scope.kind === 'project' ? join(scope.path, '.mcp.json') : paths.mcpConfig;
  const servers = readJsonFile<{ mcpServers?: Record<string, unknown> }>(file, {}).mcpServers ?? {};
  if (!Object.hasOwn(servers, id)) return undefined;
  const text = JSON.stringify(servers[id], null, 2);
  return { kind: 'mcp', id, path: file, text, hash: hashText(text) };
}

/** Содержимое одного участника; нет файла — `undefined` (участник пропал). */
function readMember(
  deps: MemberDeps,
  scope: GroupScope,
  member: { kind: string; id: string },
): MemberContent | undefined {
  // Id скилла и правила проекта — имя папки/файла: `../..` читал бы любой
  // `*.md` или каталог со SKILL.md и отдавал его модели (`/api/resources/summary`).
  const fileBacked =
    member.kind === 'skill' || (member.kind === 'rule' && scope.kind === 'project');
  if (fileBacked && safeSegment(member.id) === undefined) return undefined;
  if (member.kind === 'skill') return skillContent(deps.paths, scope, member.id);
  if (member.kind === 'rule') return ruleContent(deps, scope, member.id);
  if (member.kind === 'hook') return hookContent(deps, scope, member.id);
  if (member.kind === 'mcp') return mcpContent(deps.paths, scope, member.id);
  return undefined;
}

/** Пауза перед повтором чтения участника — как у записи в `safe-io` (десятки мс). */
const READ_RETRY_PAUSE_MS = 50;

/**
 * Текст и хэш участника; нет файла — `undefined`. Сбой чтения повторяется один
 * раз: на Windows файл, который в эту секунду пишет редактор или другой агент,
 * отвечает EBUSY/EPERM, и без повтора скилл молча пропадал из пути — у группы
 * оставались одни стадии. Не прочёлся и со второго раза — `onError`: вызывающий
 * обязан сказать об этом, а не рисовать группу без скилла.
 */
export function memberContent(
  deps: MemberDeps,
  scope: GroupScope,
  member: { kind: string; id: string },
  onError?: (error: unknown) => void,
): MemberContent | undefined {
  return withReadRetry(() => readMember(deps, scope, member), onError);
}

/**
 * Хэш участника без его текста: хэшу скилла SKILL.md отдельно не нужен —
 * каталог хэшируется целиком (`hashDir`), и лишнее чтение на каждый скилл
 * каждой копии стоило списку групп заметной доли времени (F-234).
 */
function memberHash(
  deps: MemberDeps,
  scope: GroupScope,
  member: { kind: string; id: string },
  onError?: (error: unknown) => void,
): string | undefined {
  return withReadRetry(() => {
    if (member.kind !== 'skill') return readMember(deps, scope, member)?.hash;
    if (safeSegment(member.id) === undefined) return undefined;
    const dir = skillDirFor(deps.paths, scope, member.id);
    return dir ? hashDir(dir) : undefined;
  }, onError);
}

function withReadRetry<T>(read: () => T, onError?: (error: unknown) => void): T | undefined {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return read();
    } catch (error) {
      // Битый файл проекта — не повод ронять страницу групп.
      if (attempt >= 1) {
        onError?.(error);
        return undefined;
      }
      // Пауза перед повтором: редактор держит блокировку миллисекунды, и
      // немедленный повтор упирался в ту же EBUSY — повтор ничего не давал.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_PAUSE_MS);
    }
  }
}

/** Где живёт участник: своя область у участника важнее области группы. */
export function memberScope(group: Pick<Group, 'scope'>, member: GroupMember): GroupScope {
  return member.scope ?? group.scope ?? { kind: 'global' };
}

/**
 * Хэши участников группы (`<kind>:<id>` → хэш) и общий хэш по ним. Вложенные
 * группы и права в хэш не входят: у них нет файла, который мог бы уйти вперёд.
 * `unreadable` — участники, чьё чтение сорвалось дважды (файл заблокирован):
 * их состояние неизвестно, и считать их «пропавшими» значило бы врать о дрейфе.
 */
export function memberHashes(
  deps: MemberDeps,
  group: Pick<Group, 'scope' | 'members'>,
): { hashes: Record<string, string>; hash: string; unreadable: string[] } {
  const hashes: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const member of group.members) {
    const key = memberKey(member);
    const hash = memberHash(deps, memberScope(group, member), member, () => unreadable.push(key));
    if (hash !== undefined) hashes[key] = hash;
  }
  const hash = hashText(
    Object.keys(hashes)
      .sort()
      .map((key) => `${key}=${hashes[key]}`)
      .join('\n'),
  );
  return { hashes, hash, unreadable };
}
