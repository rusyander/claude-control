import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import {
  bestMatching,
  parseVersion,
  satisfiesRange,
} from '../../lib/runtime-range/runtime-range.ts';
import {
  installedNodes,
  readNodeNeed,
  withPathPrepend,
  type InstalledRuntime,
} from './runtimes.ts';

/**
 * Node для чата в проекте: версия из `.nvmrc` / `.node-version` / `.tool-versions` /
 * `package.json` (volta, engines) — первой в PATH процесса CLI, и агент получает
 * её в каждом своём Bash без единого токена.
 *
 * Зачем (живое ревью MR, 18.10.2026): PATH по умолчанию вёл на Node 24, проект
 * просил 22, и путь к нужной версии искали три раза — обе полосы и главный чат,
 * девять вызовов у одной полосы. Подготовка копии это уже умела (`prepareNode`),
 * чат — нет.
 *
 * Синхронно, потому что `prepare` запуска синхронен: версия по умолчанию
 * спрашивается один раз на значение PATH, совпадение по каталогу живёт минуту
 * (файл версии могли поменять). В каталоге nvm-windows обычно лежит СВОЙ `claude`
 * (глобальная установка под той версией) — он подменил бы запускаемый CLI, поэтому
 * впереди ставится каталог, откуда CLI брался до подмены; если там же лежит свой
 * Node, подмена невозможна и PATH не меняется. Живая проверка 18.10.2026: без
 * этого на машине владельца подмена не срабатывала ни разу.
 */
export interface ChatNodeDeps {
  /** Вывод `node -v` по этому окружению; `undefined` — не запустился. */
  defaultNode: (env: NodeJS.ProcessEnv) => string | undefined;
  installed: (env: NodeJS.ProcessEnv) => InstalledRuntime[];
  exists: (path: string) => boolean;
  now: () => number;
}

const TTL_MS = 60_000;
const CLI_SUFFIXES = ['', '.cmd', '.exe', '.ps1', '.bat'];

export const realChatNodeDeps: ChatNodeDeps = {
  defaultNode: (env) => {
    try {
      return execFileSync('node', ['-v'], {
        env,
        timeout: 3000,
        windowsHide: true,
        encoding: 'utf8',
      }).trim();
    } catch {
      return undefined;
    }
  },
  installed: (env) =>
    installedNodes({
      env,
      platform: process.platform,
      home: homedir(),
      exec: async () => undefined,
    }),
  exists: existsSync,
  now: Date.now,
};

const NODE_NAMES = ['node', 'node.exe'];

const defaults = new Map<string, string | undefined>();
const byCwd = new Map<string, { at: number; dirs: string[] | undefined }>();

function pathOf(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return env[key] ?? '';
}

/**
 * Каталоги, которые надо поставить в начало PATH, по порядку: каталог Node проекта,
 * а если в нём свой CLI — перед ним каталог прежнего CLI. `undefined` — ничего не менять.
 */
export function chatNodeDirs(
  cwd: string,
  env: NodeJS.ProcessEnv,
  command: string,
  deps: ChatNodeDeps = realChatNodeDeps,
): string[] | undefined {
  const cached = byCwd.get(cwd);
  if (cached && deps.now() - cached.at < TTL_MS) return cached.dirs;
  const dirs = resolveDirs(cwd, env, command, deps);
  byCwd.set(cwd, { at: deps.now(), dirs });
  return dirs;
}

function holdsCli(dir: string, command: string, deps: ChatNodeDeps): boolean {
  return CLI_SUFFIXES.some((ext) => deps.exists(join(dir, `${command}${ext}`)));
}

const EXACT = /^v?(\d+)\.\d+\.\d+$/;

/**
 * Точная версия из `.nvmrc` («22.22.2») на машине не стоит — берётся новейшая той же
 * мажорной не ниже её. Без этого чат в монорепозитории оставался на Node по умолчанию:
 * корневой `.nvmrc` просит точную версию, а подготовка копии читает `engines` модулей
 * (`>=22.22.2 <23`) и ставит 22.23.2 — и задание велело агенту ставить её в PATH
 * руками, приставкой к каждому Bash (R7, живое ревью 19.10).
 */
function sameMajorOf(wanted: string, installed: InstalledRuntime[]): InstalledRuntime | undefined {
  const major = EXACT.exec(wanted.trim())?.[1];
  if (!major) return undefined;
  return bestMatching(installed, `>=${wanted.trim().replace(/^v/, '')} <${Number(major) + 1}`);
}

function resolveDirs(
  cwd: string,
  env: NodeJS.ProcessEnv,
  command: string,
  deps: ChatNodeDeps,
): string[] | undefined {
  const need = readNodeNeed(cwd, '');
  if (!need) return undefined;
  const path = pathOf(env);
  if (!defaults.has(path)) defaults.set(path, deps.defaultNode(env));
  const current = parseVersion(defaults.get(path));
  const fits = current ? satisfiesRange(current, need.wanted) : undefined;
  // Требование не разобрано или уже выполнено — менять нечего.
  if (fits !== false && current) return undefined;
  const installed = deps.installed(env);
  const best = bestMatching(installed, need.wanted) ?? sameMajorOf(need.wanted, installed);
  if (!best) return undefined;
  // Голое имя CLI ищется по PATH: свой `claude` в каталоге Node перехватил бы запуск.
  const bare = basename(command) === command;
  if (!bare || !holdsCli(best.dir, command, deps)) return [best.dir];
  const cliDir = path.split(delimiter).find((dir) => dir && holdsCli(dir, command, deps));
  // CLI не найден по PATH или рядом с ним свой Node — впереди он снова дал бы не ту версию.
  if (!cliDir || NODE_NAMES.some((name) => deps.exists(join(cliDir, name)))) return undefined;
  return [cliDir, best.dir];
}

/** Окружение чата с Node проекта впереди PATH; без требования или без нужной версии — как было. */
export function withChatNode(
  cwd: string,
  env: NodeJS.ProcessEnv,
  command: string,
  deps: ChatNodeDeps = realChatNodeDeps,
): NodeJS.ProcessEnv {
  const dirs = chatNodeDirs(cwd, env, command, deps);
  if (!dirs) return env;
  return dirs.reduceRight((acc, dir) => withPathPrepend(acc, dir), env);
}

/** Для тестов: кэш живёт весь процесс сервера. */
export function resetChatNodeCache(): void {
  defaults.clear();
  byCwd.clear();
}
