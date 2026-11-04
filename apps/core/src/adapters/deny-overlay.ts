import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PUBLISH_COMMANDS } from '../lib/publish-commands.ts';
import type { DenySet, PlatformDenyFacts } from './adapter.types.ts';

/**
 * Запреты платформы, которые несёт КАЖДЫЙ сеанс ядра (06 §Session permissions, 05 §Push
 * closure): дороги публикации (push, создание и правка MR/PR и задач, запись через API форджа),
 * дом ядра и файлы токенов. Каркас переходника вливает их в запреты шага до плана запуска — сеанс
 * без них не собирается ни у одного CLI, а `policy/permit` получает тот же набор
 * (`sessionPermitDeny`), так что оверлей CLI, хук ядра и сервер права решают по одним фактам.
 * Дороги публикации — один список с судьёй (`lib/publish-commands.ts`, F-04).
 */

export { PUBLISH_COMMANDS };

/**
 * Каталоги настроек CLI в копии: файл настроек проекта несёт хуки и окружение, а хук исполняется
 * вне системы прав — подложенный в шаге с правкой, он сработал бы в следующем шаге «только
 * чтение» (verify-cli V2). Правка закрыта у каждого CLI: шаг Qwen подложил бы хук шагу Claude.
 */
export const CLI_PROJECT_DIRS: readonly string[] = ['.claude', '.qwen'];

const key = (argv: readonly string[]): string => JSON.stringify(argv);

function unique<T>(items: readonly T[], id: (item: T) => string = String): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = id(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function platformDenySet(facts: PlatformDenyFacts): DenySet {
  return {
    paths: unique([facts.coreHome, ...facts.tokenFiles]),
    commands: PUBLISH_COMMANDS.map((argv) => [...argv]),
    mcpTools: unique([...(facts.forgeMcpTools ?? [])]),
    tools: [],
    ...(facts.forgeMcpServers?.length ? { forgeMcpServers: unique(facts.forgeMcpServers) } : {}),
  };
}

const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** cwd и все каталоги над ним до корня ФС, от ближнего. */
export function ancestorDirs(cwd: string): string[] {
  const out: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    out.push(dir);
    if (dirname(dir) === dir) return out;
  }
}

/** Служебные каталоги одного `.git` (каталог — он сам; файл рабочего дерева — и его gitdir). */
function gitDirsAt(dir: string): string[] {
  const dotGit = join(dir, '.git');
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(dotGit, { throwIfNoEntry: false });
  } catch {
    // Не прочли, есть ли он (EACCES, EPERM): запрещаем, как если бы был.
    return [dotGit];
  }
  if (!stats) return [];
  if (stats.isDirectory()) return [dotGit];
  const target = GITDIR_LINE.exec(readText(dotGit) ?? '')?.[1];
  if (!target) return [dotGit];
  const gitdir = resolve(dir, target);
  const common = readText(join(gitdir, 'commondir'))?.trim();
  return [dotGit, gitdir, ...(common ? [resolve(gitdir, common)] : [])];
}

/**
 * Служебные каталоги git копии — правка запрещена каждой дорогой (настройки `.git/config` дают
 * `pushurl` и `hooksPath`, хуки исполняются ядром при коммите; 05 §Push closure). Ищутся вверх от
 * cwd, как ищет сам git, но НЕ до первого: cwd во вложенном репозитории (подмодуль, вендорный
 * клон) нашёл бы только его `.git`, а `.git` самой копии остался бы открыт (F-37). Лишний запрет
 * над копией безвреден — правка вне копии и так закрыта судьёй. `.git` — каталог: он сам. `.git` —
 * файл (рабочее дерево): он сам, его `gitdir:` и общий каталог из `commondir` (там `config` и
 * `hooks` всех деревьев). Файл не читается — запрещён хотя бы он: разрешать то, чего не
 * разобрали, нельзя.
 */
export function copyGitDirs(cwd: string): string[] {
  return unique(ancestorDirs(cwd).flatMap(gitDirsAt));
}

/**
 * Каталоги настроек CLI, которые сеанс не правит: на cwd и на каждом уровне над ним до корня
 * самого внешнего репозитория (CLI берёт настройки проекта у своего cwd, а следующий шаг может
 * начаться выше — в корне копии). Репозитория нет — только у cwd.
 */
export function cliProjectDirs(cwd: string): string[] {
  const levels = ancestorDirs(cwd);
  let top = 0;
  levels.forEach((dir, index) => {
    if (gitDirsAt(dir).length > 0) top = index;
  });
  return levels.slice(0, top + 1).flatMap((dir) => CLI_PROJECT_DIRS.map((name) => join(dir, name)));
}

/**
 * Запреты шага поверх запретов платформы: снять платформенный запрет шаг не может. `cwd` есть —
 * служебный каталог git копии и каталоги настроек CLI (`.claude`, `.qwen`, `cliProjectDirs`)
 * запрещены к правке (чтение остаётся, если его не запретили иначе): правило оверлея CLI старше
 * `allow: Edit` слоя человека, а хук ядра ставится не всегда.
 */
export function withPlatformDeny(facts: PlatformDenyFacts, step: DenySet, cwd?: string): DenySet {
  const base = platformDenySet(facts);
  const paths = unique([...base.paths, ...step.paths]);
  // Сервер форжа шаг снять не может, как и любой запрет платформы (`forge-mcp-read-only`).
  const forge = unique([...(base.forgeMcpServers ?? []), ...(step.forgeMcpServers ?? [])]);
  const editPaths = unique([
    ...(cwd ? copyGitDirs(cwd) : []),
    ...(cwd ? cliProjectDirs(cwd) : []),
    ...(step.editPaths ?? []),
  ]).filter((path) => !paths.includes(path));
  return {
    paths,
    ...(editPaths.length > 0 ? { editPaths } : {}),
    commands: unique([...base.commands, ...step.commands], key),
    mcpTools: unique([...base.mcpTools, ...step.mcpTools]),
    tools: unique([...base.tools, ...step.tools]),
    ...(forge.length > 0 ? { forgeMcpServers: forge } : {}),
  };
}

/**
 * Запреты для судьи сеанса (`PermitContext.deny` / `platformPaths`) — тот же набор, что оверлей
 * CLI получает при запуске (`withPlatformDeny`), а не список, собранный рукой у вызывающего
 * (F-11: e2e судил по одному `git push`). Пути платформы — дом ядра и файлы токенов.
 */
export function sessionPermitDeny(
  facts: PlatformDenyFacts,
  step: DenySet,
  cwd: string,
): { deny: DenySet; platformPaths: string[] } {
  return { deny: withPlatformDeny(facts, step, cwd), platformPaths: platformDenySet(facts).paths };
}
