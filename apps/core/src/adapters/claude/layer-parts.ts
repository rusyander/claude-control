import { basename, join, relative } from 'node:path';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import {
  agentModelOf,
  carriesHooks,
  inventoryHash,
  listDirs,
  listFiles,
  nameOf,
  parseFrontmatter,
  readSource,
  skillFlowOf,
  type Frontmatter,
  type Source,
  type Unread,
} from '../layer-inventory.ts';
import type { InventorySession } from '../adapter.types.ts';
import { claudeSessionHooks } from './session-hooks.ts';
import { claudeConfigDir, readUserLayer, userLayerFiles } from './user-layer.ts';

/**
 * Слой человека Claude Code по частям (01:18, 06:114-129): файлы настроек, инструкции, правила,
 * навыки, команды, агенты — где их ищет CLI 2.1.310 (проба Q4). Из частей строится опись (хеш
 * слоя) и подача частей в `observe`/`off`, где `--setting-sources ''` не грузит ни одной.
 * Недоверенная копия (`repoLayer: false`) — частей репозитория нет вовсе (F-86).
 */

type Scope = Source['scope'];

export interface InstructionFile {
  path: string;
  scope: Scope;
  /** Текст без frontmatter (правило с `paths:` — тоже текст). */
  text: string;
  /** Правило с `paths:` во frontmatter: подача грузит его безусловно (потеря названа). */
  pathScoped: boolean;
  /** Строки `@путь`: подача склейкой их не раскрывает (потеря названа). */
  imports: boolean;
}

export interface LayerEntry {
  name: string;
  scope: Scope;
  /** Навык — каталог; агент и команда — файл. */
  path: string;
  /** Путь относительно своего корня (`skills/`, `agents/`, `commands/`) — так и копируется. */
  rel: string;
  hooks: boolean;
  fm: Frontmatter | null;
}

export interface ClaudeLayerParts {
  sources: Source[];
  unread: Unread[];
  /** Разобранные файлы настроек (канонический JSON входит в хеш). */
  settings: Record<string, unknown>;
  userInstructions: InstructionFile[];
  projectInstructions: InstructionFile[];
  skills: LayerEntry[];
  commands: LayerEntry[];
  agents: LayerEntry[];
}

const md = (name: string): boolean => name.toLowerCase().endsWith('.md');
const IMPORT_LINE = /^@\S/m;

export function claudeLayerParts(
  pin: Record<string, string>,
  cwd: string,
  repoLayer: boolean,
): ClaudeLayerParts {
  const config = claudeConfigDir(pin);
  const project = join(cwd, '.claude');
  const parts: ClaudeLayerParts = {
    sources: [],
    unread: [],
    settings: {},
    userInstructions: [],
    projectInstructions: [],
    skills: [],
    commands: [],
    agents: [],
  };
  const take = (path: string, kind: Source['kind'], scope: Scope): string | null => {
    const got = readSource(path);
    if (!got) return null;
    if ('unread' in got) {
      parts.unread.push({ path, reason: got.unread });
      return null;
    }
    parts.sources.push({ kind, scope, path, sha256: got.sha256, bytes: got.bytes });
    return got.text;
  };

  for (const file of userLayerFiles(pin, cwd, repoLayer)) {
    const scope: Scope =
      file.source === 'user' ? 'user' : file.path.endsWith('.local.json') ? 'local' : 'project';
    const text = take(file.path, 'settings', scope);
    if (text === null) continue;
    try {
      parts.settings[file.path] = JSON.parse(text) as unknown;
    } catch {
      // Порча не молчит: такой файл и так отказывает запуск вне `on` (`refuseClaude`).
      parts.settings[file.path] = { unparsed: true };
    }
  }

  const instruction = (path: string, kind: 'instructions' | 'rules', scope: Scope) => {
    const text = take(path, kind, scope);
    if (text === null) return;
    const fm = parseFrontmatter(text);
    const list = scope === 'user' ? parts.userInstructions : parts.projectInstructions;
    list.push({
      path,
      scope,
      text: fm ? fm.body : text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'),
      pathScoped: fm?.data.paths !== undefined,
      imports: IMPORT_LINE.test(fm ? fm.body : text),
    });
  };
  instruction(join(config, 'CLAUDE.md'), 'instructions', 'user');
  for (const path of listFiles(join(config, 'rules'), md, true, parts.unread)) {
    instruction(path, 'rules', 'user');
  }
  if (repoLayer) {
    instruction(join(cwd, 'CLAUDE.md'), 'instructions', 'project');
    instruction(join(project, 'CLAUDE.md'), 'instructions', 'project');
    instruction(join(cwd, 'CLAUDE.local.md'), 'instructions', 'local');
    for (const path of listFiles(join(project, 'rules'), md, true, parts.unread)) {
      instruction(path, 'rules', 'project');
    }
  }

  const roots: [string, Scope][] = [
    [config, 'user'],
    ...(repoLayer ? [[project, 'project'] as [string, Scope]] : []),
  ];
  for (const [root, scope] of roots) {
    for (const dir of listDirs(join(root, 'skills'), parts.unread)) {
      const text = take(join(dir, 'SKILL.md'), 'skill', scope);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const rel = basename(dir);
      parts.skills.push({
        name: nameOf(fm, rel),
        scope,
        path: dir,
        rel,
        hooks: carriesHooks(fm),
        fm,
      });
    }
    const commands = join(root, 'commands');
    for (const path of listFiles(commands, md, true, parts.unread)) {
      const text = take(path, 'skill', scope);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const rel = relative(commands, path);
      parts.commands.push({
        name: rel.replace(/\.md$/i, '').split(/[\\/]/).join(':'),
        scope,
        path,
        rel,
        hooks: carriesHooks(fm),
        fm,
      });
    }
    const agents = join(root, 'agents');
    for (const path of listFiles(agents, md, false, parts.unread)) {
      const text = take(path, 'agent', scope);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const rel = relative(agents, path);
      parts.agents.push({
        name: nameOf(fm, basename(path).replace(/\.md$/i, '')),
        scope,
        path,
        rel,
        hooks: carriesHooks(fm),
        fm,
      });
    }
  }
  return parts;
}

/**
 * Опись слоя Claude (`LayerPolicy.inventory`): части + хуки с ключами записи `observe`. С фактами
 * сеанса — и хуки, которые CLI исполняет помимо файлов настроек (плагины набора, локальный слой,
 * включённые плагины; `session-hooks.ts`), их файлы — источники описи и её хеша.
 */
export function claudeInventory(
  pin: Record<string, string>,
  cwd: string,
  repoLayer: boolean,
  session?: InventorySession,
): UserLayerInventory {
  const parts = claudeLayerParts(pin, cwd, repoLayer);
  const user = readUserLayer(userLayerFiles(pin, cwd, repoLayer));
  const run = claudeSessionHooks(pin, cwd, repoLayer, session);
  const unread = [...parts.unread];
  for (const path of user.unreadable) {
    if (!unread.some((u) => u.path === path))
      unread.push({ path, reason: 'not valid settings JSON' });
  }
  for (const u of run.unread) if (!unread.some((x) => x.path === u.path)) unread.push(u);
  const sources = [...parts.sources, ...run.sources];
  return {
    cli: 'claude',
    hash: inventoryHash(sources, unread, parts.settings),
    sources,
    hooks: run.hooks.map((hook) => ({
      key: hook.key,
      event: hook.event,
      matcher: hook.matcher ?? null,
      command: hook.command,
      sourcePath: hook.sourcePath,
    })),
    skills: [...parts.skills, ...parts.commands].map((entry) => ({
      name: entry.name,
      path: entry.path,
      ...skillFlowOf(entry.fm),
    })),
    agents: parts.agents.map((entry) => ({
      name: entry.name,
      model: agentModelOf(entry.fm),
      path: entry.path,
    })),
    unread,
  };
}

/** Слой `on`: части читает сам CLI, подавать нечего. */
export const EMPTY_PARTS: ClaudeLayerParts = {
  sources: [],
  unread: [],
  settings: {},
  userInstructions: [],
  projectInstructions: [],
  skills: [],
  commands: [],
  agents: [],
};
