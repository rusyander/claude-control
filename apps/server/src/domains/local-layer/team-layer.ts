import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { gitSync } from '../project-git/exec/exec.ts';
import { layoutForCwd } from '../project-git/cwd-layout.ts';
import { globToRegExp } from '../project-git/mirror-local.ts';
import { parseRule } from './frontmatter.ts';
import type { PathRule, TeamLayer, TextEntry } from './local-layer.types.ts';

/**
 * Командный слой проекта — ровно то, что CLI грузит из источника `project` и что
 * флаг `--setting-sources user,local` снимает (замерено пробой 18.10.2026 на
 * claude 2.1.286 против стаба: `CLAUDE.md`, правила с `paths` и без, вложенные
 * `CLAUDE.md`, навыки `.claude/skills`, серверы `.mcp.json`, хуки
 * `.claude/settings.json` — всё ушло; `CLAUDE.local.md` остался).
 *
 * Читается с учётом `claudeMdExcludes`: снятое человеком не грузится и без
 * слоя, значит, не едет и в слое.
 */

export interface TeamPlace {
  /** Домашний каталог: его `.claude/CLAUDE.md` — личный слой, а не проектный. */
  home: string;
  /** Каталог конфигурации CLI (`CLAUDE_CONFIG_DIR` или `~/.claude`). */
  configDir: string;
  caseless: boolean;
}

const MAX_IMPORT_DEPTH = 5;

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

const slash = (path: string): string => path.replaceAll('\\', '/');

/** Файлы настроек трёх источников — те же, что читает CLI. */
export function settingsFiles(root: string, place: TeamPlace): string[] {
  return [
    join(place.configDir, 'settings.json'),
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
  ];
}

/**
 * Снят ли файл шаблонами `claudeMdExcludes`. В копии проекта шаблоны человека
 * написаны под оригинал — поэтому путь проверяется и в написании оригинала.
 */
function excluder(root: string, place: TeamPlace): (file: string) => boolean {
  const patterns = settingsFiles(root, place).flatMap((file) =>
    strings(readJson(file)?.claudeMdExcludes),
  );
  if (patterns.length === 0) return () => false;
  const res = patterns.map(
    (pattern) => new RegExp(globToRegExp(slash(pattern)).source, place.caseless ? 'i' : ''),
  );
  const { mainDir, copyDir } = layoutForCwd(root);
  return (file) => {
    const paths = [slash(file)];
    if (mainDir && copyDir) {
      const rel = relative(copyDir, file);
      if (!rel.startsWith('..') && !isAbsolute(rel)) paths.push(slash(join(mainDir, rel)));
    }
    return paths.some((path) => res.some((re) => re.test(path)));
  };
}

/** Каталоги от корня диска до `root` включительно — порядок, в котором CLI склеивает цепочку. */
function chain(root: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(root);
  for (;;) {
    dirs.unshift(dir);
    const up = dirname(dir);
    if (up === dir || dir === parse(dir).root) break;
    dir = up;
  }
  return dirs;
}

function walk(dir: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out.sort();
}

/**
 * Импорты `@путь` в инструкциях — CLI разворачивает их сам, слой обязан тоже,
 * иначе дословная копия потеряла бы импортированный текст. Внутри блоков кода
 * `@` — не импорт.
 */
function importsOf(file: string, text: string, home: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const match of line.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+\.[\w]+)/g)) {
      const raw = match[1] as string;
      const target = raw.startsWith('~/') ? join(home, raw.slice(2)) : resolve(dirname(file), raw);
      if (existsSync(target) && statSync(target).isFile()) found.push(target);
    }
  }
  return found;
}

function withImports(
  files: readonly string[],
  home: string,
  excluded: (file: string) => boolean,
): TextEntry[] {
  const seen = new Set<string>();
  const out: TextEntry[] = [];
  const add = (file: string, depth: number): void => {
    const key = slash(file).toLowerCase();
    if (seen.has(key) || excluded(file)) return;
    seen.add(key);
    const text = readFileSync(file, 'utf8');
    out.push({ path: file, text });
    if (depth < MAX_IMPORT_DEPTH)
      for (const next of importsOf(file, text, home)) add(next, depth + 1);
  };
  for (const file of files) add(file, 0);
  return out;
}

/** Вложенные `CLAUDE.md` и `.claude/rules` подпроектов — по списку git, без обхода `node_modules`. */
function nestedFiles(root: string): string[] {
  const out = gitSync(
    root,
    [
      'ls-files',
      '-co',
      '--exclude-standard',
      '-z',
      '--',
      ':(glob)**/CLAUDE.md',
      ':(glob)**/.claude/CLAUDE.md',
      ':(glob)**/.claude/rules/**/*.md',
    ],
    10_000,
  );
  if (!out) return [];
  return out
    .split('\0')
    .filter(Boolean)
    .map((rel) => join(root, rel))
    .filter((file) => {
      const rel = slash(relative(root, file));
      return (
        rel !== 'CLAUDE.md' && rel !== '.claude/CLAUDE.md' && !rel.startsWith('.claude/rules/')
      );
    });
}

function nestedRule(root: string, file: string): PathRule {
  const rel = slash(relative(root, file));
  const ruleAt = rel.indexOf('.claude/rules/');
  if (ruleAt >= 0) {
    const base = join(root, rel.slice(0, Math.max(0, ruleAt - 1)));
    const parsed = parseRule(readFileSync(file, 'utf8'));
    return { path: file, text: parsed.body, base, globs: parsed.paths ?? ['**'] };
  }
  const dir = rel.endsWith('.claude/CLAUDE.md') ? dirname(dirname(file)) : dirname(file);
  return { path: file, text: readFileSync(file, 'utf8'), base: dir, globs: ['**'] };
}

/**
 * Серверы `.mcp.json`, которые CLI поднял бы: все при `enableAllProjectMcpServers`,
 * иначе перечисленные в `enabledMcpjsonServers`, минус `disabledMcpjsonServers`.
 * Согласие человека CLI пишет в `settings.local.json` — его и хватает; `~/.claude.json`
 * не читается: CLI переписывает его на каждом шаге, и отпечаток слоя менялся бы всегда.
 */
function enabledMcp(root: string, place: TeamPlace): Record<string, unknown> {
  const servers = readJson(join(root, '.mcp.json'))?.mcpServers;
  if (!servers || typeof servers !== 'object') return {};
  const sources = settingsFiles(root, place).map(readJson);
  const all = sources.some((source) => source?.enableAllProjectMcpServers === true);
  const enabled = new Set(sources.flatMap((source) => strings(source?.enabledMcpjsonServers)));
  const disabled = new Set(sources.flatMap((source) => strings(source?.disabledMcpjsonServers)));
  return Object.fromEntries(
    Object.entries(servers as Record<string, unknown>).filter(
      ([name]) => (all || enabled.has(name)) && !disabled.has(name),
    ),
  );
}

export function readTeamLayer(root: string, place: TeamPlace): TeamLayer {
  const excluded = excluder(root, place);
  const dropped: string[] = [];
  const keep = (file: string): boolean => {
    if (!excluded(file)) return true;
    dropped.push(file);
    return false;
  };

  // Цепочка инструкций: `CLAUDE.md` предков и самого проекта. Ни одного —
  // CLI читает `AGENTS.md` той же цепочкой.
  const personal = slash(join(place.home, '.claude', 'CLAUDE.md')).toLowerCase();
  const configMemory = slash(join(place.configDir, 'CLAUDE.md')).toLowerCase();
  const named = (name: string): string[] =>
    chain(root).flatMap((dir) =>
      [join(dir, name), join(dir, '.claude', name)].filter((file) => {
        const key = slash(file).toLowerCase();
        return key !== personal && key !== configMemory && existsSync(file);
      }),
    );
  const claudeChain = named('CLAUDE.md');
  const starts = (claudeChain.length > 0 ? claudeChain : named('AGENTS.md')).filter(keep);

  const rulesDir = join(root, '.claude', 'rules');
  const always: string[] = [];
  const pathRules: PathRule[] = [];
  for (const file of walk(rulesDir, (file) => file.endsWith('.md')).filter(keep)) {
    const parsed = parseRule(readFileSync(file, 'utf8'));
    if (parsed.paths?.length)
      pathRules.push({ path: file, text: parsed.body, base: root, globs: parsed.paths });
    else always.push(file);
  }
  const instructions = [
    ...withImports(starts, place.home, excluded),
    ...always.map((file) => ({ path: file, text: parseRule(readFileSync(file, 'utf8')).body })),
  ];
  for (const file of nestedFiles(root).filter(keep)) pathRules.push(nestedRule(root, file));

  const settingsPath = join(root, '.claude', 'settings.json');
  const skillsDir = join(root, '.claude', 'skills');
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')),
        )
        .map((entry) => join(skillsDir, entry.name))
        .sort()
    : [];
  return {
    root,
    instructions,
    pathRules,
    ...(existsSync(settingsPath) ? { settingsPath, settings: readJson(settingsPath) ?? {} } : {}),
    skills,
    agents: walk(join(root, '.claude', 'agents'), (file) => file.endsWith('.md')),
    commands: walk(join(root, '.claude', 'commands'), (file) => file.endsWith('.md')),
    mcp: enabledMcp(root, place),
    excluded: dropped,
  };
}

/**
 * Пути, от которых зависит слой, — для отпечатка: сами файлы командного слоя и
 * то, что решает, какие из них действуют. Содержимое здесь не читается: отпечаток
 * снимается на каждом старте чата и обязан стоить единицы миллисекунд.
 */
export function teamSourcePaths(root: string, place: TeamPlace): string[] {
  const claude = join(root, '.claude');
  return [
    ...chain(root).flatMap((dir) =>
      ['CLAUDE.md', 'AGENTS.md'].flatMap((name) => [join(dir, name), join(dir, '.claude', name)]),
    ),
    ...walk(join(claude, 'rules'), () => true),
    ...walk(join(claude, 'skills'), () => true),
    ...walk(join(claude, 'agents'), () => true),
    ...walk(join(claude, 'commands'), () => true),
    ...nestedFiles(root),
    join(root, '.mcp.json'),
    ...settingsFiles(root, place),
  ];
}
