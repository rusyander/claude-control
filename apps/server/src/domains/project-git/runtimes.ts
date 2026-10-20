import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import type { WorktreeRuntimeNote } from '@agentdeck/contracts';
import {
  bestMatching,
  formatVersion,
  parseVersion,
  satisfiesRange,
  wantedRange,
  type Triple,
} from '../../lib/runtime-range/runtime-range.ts';

/**
 * Рантайм, который просит проект, и где он стоит на этой машине.
 *
 * Зачем (живое ревью MR, 13.10.2026): подготовка копии шла на Node 24 при
 * `.nvmrc` 22 — `npm ci` падал с кодом 2, фронтовые гейты отказывались работать,
 * а группа сама искала nvm и пересобирала зависимости. Панель берёт версию из
 * файлов проекта и запускает подготовку на ней; нет такой на машине — говорит это
 * на карточке и в задании, а не отдаёт «решай сам». Всё — по файлам проекта и
 * каталогам менеджеров версий (nvm, nvm-windows, fnm, volta, asdf, mise, nodenv,
 * n, pyenv), без привязки к одной системе или одному проекту.
 */

export type RuntimeTool = WorktreeRuntimeNote['tool'];

export interface RuntimeNeed {
  tool: RuntimeTool;
  /** Диапазон или версия — как её понимает `satisfiesRange`. */
  wanted: string;
  /** Откуда взято: имя файла (и поле) — оно же уходит на карточку. */
  source: string;
}

/** Запуск и окружение — подменяются в тесте: настоящих версий на машине CI нет. */
export interface RuntimeDeps {
  /** stdout запуска или `undefined`, если не запустилось за срок. */
  exec: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}

const EXEC_TIMEOUT_MS = 5000;

export function realRuntimeDeps(env: NodeJS.ProcessEnv = process.env): RuntimeDeps {
  return {
    exec: (file, args, runEnv) =>
      new Promise((done) => {
        try {
          execFile(
            file,
            args,
            { env: runEnv, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
            (error, stdout, stderr) => done(error ? undefined : `${stdout}${stderr}`.trim()),
          );
        } catch {
          done(undefined);
        }
      }),
    env,
    platform: process.platform,
    home: homedir(),
  };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Первая значащая строка файла версий; комментарии `#` отброшены. */
function firstLine(text: string | undefined): string | undefined {
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (line) return line;
  }
  return undefined;
}

/** Версия инструмента из `.tool-versions` (asdf, mise): `nodejs 22.22.2 20.1.0`. */
function toolVersionsEntry(text: string | undefined, names: readonly string[]): string | undefined {
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const [name, ...versions] = raw.replace(/#.*/, '').trim().split(/\s+/);
    if (name && names.includes(name) && versions[0]) return versions[0];
  }
  return undefined;
}

/** От каталога вверх до корня копии включительно: ближайший файл важнее дальнего. */
function ancestors(root: string, cwd: string): string[] {
  const top = resolve(root);
  const dirs: string[] = [];
  let current = resolve(top, cwd);
  for (let step = 0; step < 12; step += 1) {
    dirs.push(current);
    if (current === top) break;
    const parent = dirname(current);
    if (parent === current || !current.startsWith(top + sep)) break;
    current = parent;
  }
  return dirs;
}

function relativeName(root: string, file: string): string {
  const base = resolve(root);
  const full = resolve(file);
  return full.startsWith(base + sep) ? full.slice(base.length + 1).replace(/\\/g, '/') : full;
}

/** Версия Node, которую просит проект для каталога `cwd` копии. */
export function readNodeNeed(root: string, cwd: string): RuntimeNeed | undefined {
  for (const dir of ancestors(root, cwd)) {
    for (const name of ['.nvmrc', '.node-version']) {
      const file = join(dir, name);
      const wanted = wantedRange(firstLine(readText(file)));
      if (wanted) return { tool: 'node', wanted, source: relativeName(root, file) };
    }
    const toolFile = join(dir, '.tool-versions');
    const tool = wantedRange(toolVersionsEntry(readText(toolFile), ['nodejs', 'node']));
    if (tool) return { tool: 'node', wanted: tool, source: relativeName(root, toolFile) };
    const manifest = join(dir, 'package.json');
    const text = readText(manifest);
    if (text) {
      try {
        const json = JSON.parse(text) as {
          volta?: { node?: unknown };
          engines?: { node?: unknown };
        };
        const volta =
          typeof json.volta?.node === 'string' ? wantedRange(json.volta.node) : undefined;
        if (volta) {
          return { tool: 'node', wanted: volta, source: `${relativeName(root, manifest)} volta` };
        }
        const engines =
          typeof json.engines?.node === 'string' ? wantedRange(json.engines.node) : undefined;
        if (engines) {
          return {
            tool: 'node',
            wanted: engines,
            source: `${relativeName(root, manifest)} engines`,
          };
        }
      } catch {
        // Битый манифест — не требование: установка сама скажет, что с ним не так.
      }
    }
  }
  return undefined;
}

/** Версия Python, которую просит проект в каталоге `dir` (корень Python-проекта). */
export function readPythonNeed(root: string, dir: string): RuntimeNeed | undefined {
  const at = (name: string): string => join(resolve(root, dir), name);
  const pinned = wantedRange(firstLine(readText(at('.python-version'))));
  if (pinned)
    return { tool: 'python', wanted: pinned, source: relativeName(root, at('.python-version')) };
  const tool = wantedRange(toolVersionsEntry(readText(at('.tool-versions')), ['python']));
  if (tool)
    return { tool: 'python', wanted: tool, source: relativeName(root, at('.tool-versions')) };
  const runtime = /^python-(\d[\w.]*)/m.exec(readText(at('runtime.txt')) ?? '')?.[1];
  if (runtime)
    return { tool: 'python', wanted: runtime, source: relativeName(root, at('runtime.txt')) };
  const pyproject = readText(at('pyproject.toml'));
  const requires = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject ?? '')?.[1];
  const wantedPyproject = wantedRange(requires);
  if (wantedPyproject) {
    return {
      tool: 'python',
      wanted: wantedPyproject,
      source: `${relativeName(root, at('pyproject.toml'))} requires-python`,
    };
  }
  const poetry = /\[tool\.poetry\.dependencies\][^[]*?^\s*python\s*=\s*["']([^"']+)["']/ms.exec(
    pyproject ?? '',
  )?.[1];
  const wantedPoetry = wantedRange(poetry);
  if (wantedPoetry) {
    return {
      tool: 'python',
      wanted: wantedPoetry,
      source: `${relativeName(root, at('pyproject.toml'))} poetry`,
    };
  }
  const pipfile = /^\s*python_version\s*=\s*["']([^"']+)["']/m.exec(
    readText(at('Pipfile')) ?? '',
  )?.[1];
  const wantedPipfile = wantedRange(pipfile);
  if (wantedPipfile) {
    return { tool: 'python', wanted: wantedPipfile, source: relativeName(root, at('Pipfile')) };
  }
  return undefined;
}

/** Версия Go из `go.mod`: директива `go` — нижняя граница. */
export function readGoNeed(root: string, dir: string): RuntimeNeed | undefined {
  const file = join(resolve(root, dir), 'go.mod');
  const text = readText(file);
  if (!text) return undefined;
  const version = /^\s*go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text)?.[1];
  return version
    ? { tool: 'go', wanted: `>=${version}`, source: `${relativeName(root, file)} go` }
    : undefined;
}

// ---------------------------------------------------------------- где стоит

export interface InstalledRuntime {
  version: Triple;
  text: string;
  /** Каталог с исполняемым файлом: его ставят в начало PATH. */
  dir: string;
  manager: string;
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

/** Копия окружения с каталогом в начале PATH (регистр ключа — как у системы: `Path` на Windows). */
export function withPathPrepend(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = pathKey(env);
  return { ...env, [key]: `${dir}${delimiter}${env[key] ?? ''}` };
}

/**
 * Все Node, установленные менеджерами версий. Версия — по имени каталога, без
 * запуска: сотня запусков `node -v` на каждый ввод стоила бы секунды, а имя
 * каталога менеджеры задают сами. Каталог принимается, только если в нём есть
 * исполняемый файл.
 */
export function installedNodes(deps: RuntimeDeps): InstalledRuntime[] {
  const { env, home, platform } = deps;
  const win = platform === 'win32';
  const exe = win ? 'node.exe' : 'node';
  const found: InstalledRuntime[] = [];
  const scan = (root: string | undefined, manager: string, layout: (name: string) => string) => {
    if (!root) return;
    for (const name of listDirs(root)) {
      const version = parseVersion(name);
      if (!version) continue;
      const dir = layout(join(root, name));
      if (existsSync(join(dir, exe))) {
        found.push({ version, text: formatVersion(version), dir, manager });
      }
    }
  };
  const bin = (dir: string): string => (win ? dir : join(dir, 'bin'));
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const localData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  // nvm-windows кладёт версии рядом с самим nvm, без bin.
  scan(env.NVM_HOME ?? (win ? join(appData, 'nvm') : undefined), 'nvm-windows', (dir) => dir);
  scan(join(env.NVM_DIR ?? join(home, '.nvm'), 'versions', 'node'), 'nvm', bin);
  // FNM_DIR задаёт только `fnm env` в интерактивной оболочке — панель от keepalive,
  // launchd или systemd его не видит. Тогда все места, которые fnm выбирал в разных
  // версиях: старый `~/.fnm` (он и сейчас первый, если есть), XDG и, на macOS, Application Support.
  const fnmRoots = win
    ? [join(localData, 'fnm')]
    : [
        join(home, '.fnm'),
        join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'fnm'),
        ...(platform === 'darwin' ? [join(home, 'Library', 'Application Support', 'fnm')] : []),
      ];
  for (const fnmRoot of new Set(env.FNM_DIR ? [env.FNM_DIR] : fnmRoots)) {
    scan(join(fnmRoot, 'node-versions'), 'fnm', (dir) => {
      const installation = join(dir, 'installation');
      return win ? installation : join(installation, 'bin');
    });
  }
  const volta = env.VOLTA_HOME ?? (win ? join(localData, 'Volta') : join(home, '.volta'));
  scan(join(volta, 'tools', 'image', 'node'), 'volta', bin);
  scan(join(env.ASDF_DATA_DIR ?? join(home, '.asdf'), 'installs', 'nodejs'), 'asdf', bin);
  scan(
    join(
      env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'mise'),
      'installs',
      'node',
    ),
    'mise',
    bin,
  );
  scan(join(env.NODENV_ROOT ?? join(home, '.nodenv'), 'versions'), 'nodenv', bin);
  scan(join(env.N_PREFIX ?? '/usr/local', 'n', 'versions', 'node'), 'n', bin);
  return found;
}

/** Версия исполняемого файла по умолчанию — той, что нашёл бы `PATH` процесса подготовки. */
export async function defaultVersion(
  tool: RuntimeTool,
  deps: RuntimeDeps,
): Promise<{ version: Triple; text: string } | undefined> {
  const out =
    tool === 'node'
      ? await deps.exec('node', ['-v'], deps.env)
      : tool === 'go'
        ? await deps.exec('go', ['version'], deps.env)
        : await deps.exec('python', ['--version'], deps.env);
  const version = parseVersion(out);
  return version ? { version, text: formatVersion(version) } : undefined;
}

export interface PreparedRuntime {
  note: WorktreeRuntimeNote;
  /** Окружение процесса подготовки: PATH с найденной версией впереди; нет — как у панели. */
  env: NodeJS.ProcessEnv;
}

/**
 * Окружение подготовки каталога `cwd` копии по версии Node из файлов проекта.
 * Версии не задано — `undefined`, подготовка идёт как шла.
 */
export async function prepareNode(
  root: string,
  cwd: string,
  deps: RuntimeDeps,
): Promise<PreparedRuntime | undefined> {
  const need = readNodeNeed(root, cwd);
  if (!need) return undefined;
  const base = { tool: 'node' as const, where: cwd, wanted: need.wanted, source: need.source };
  const current = await defaultVersion('node', deps);
  const fits = current ? satisfiesRange(current.version, need.wanted) : undefined;
  // «Не понял запись» — требования нет, подменять нечем и незачем.
  if (fits === undefined && current) return undefined;
  if (current && fits) {
    return { note: { ...base, status: 'ok', used: current.text }, env: deps.env };
  }
  const best = bestMatching(installedNodes(deps), need.wanted);
  if (best) {
    return {
      note: {
        ...base,
        status: 'switched',
        used: best.text,
        ...(current ? { found: current.text } : {}),
        detail: `${best.manager}: ${best.dir}`,
      },
      env: withPathPrepend(deps.env, best.dir),
    };
  }
  return {
    note: {
      ...base,
      status: 'missing',
      ...(current ? { found: current.text, used: current.text } : {}),
    },
    env: deps.env,
  };
}

// ---------------------------------------------------------------- Python и Go

const PY_PROBE = ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'];

/** Кандидаты в интерпретаторы: лаунчер Windows, имена в PATH, менеджеры версий, типовые каталоги. */
async function pythonCandidates(deps: RuntimeDeps): Promise<string[]> {
  const { env, home, platform } = deps;
  const win = platform === 'win32';
  const paths = new Set<string>();
  if (win) {
    const listing = await deps.exec('py', ['-0p'], env);
    for (const line of (listing ?? '').split(/\r?\n/)) {
      const match = /([A-Za-z]:\\.*\.exe)\s*$/i.exec(line);
      if (match) paths.add(match[1] as string);
    }
  }
  for (let minor = 15; minor >= 8; minor -= 1) paths.add(`python3.${minor}`);
  paths.add('python3');
  paths.add('python');
  const exe = win ? 'python.exe' : 'python';
  const bin = (dir: string): string => (win ? join(dir, exe) : join(dir, 'bin', exe));
  const roots: Array<[string, string]> = [
    [
      join(
        env.PYENV_ROOT ?? join(home, '.pyenv'),
        win ? join('pyenv-win', 'versions') : 'versions',
      ),
      'pyenv',
    ],
    [join(env.ASDF_DATA_DIR ?? join(home, '.asdf'), 'installs', 'python'), 'asdf'],
    [
      join(
        env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'mise'),
        'installs',
        'python',
      ),
      'mise',
    ],
  ];
  for (const [root] of roots) {
    for (const name of listDirs(root)) {
      const file = bin(join(root, name));
      if (existsSync(file)) paths.add(file);
    }
  }
  if (!win) {
    for (const dir of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
      for (let minor = 15; minor >= 8; minor -= 1) {
        const file = join(dir, `python3.${minor}`);
        if (existsSync(file)) paths.add(file);
      }
    }
  }
  return [...paths];
}

export interface FoundPython {
  version: Triple;
  text: string;
  /** Что запускать: абсолютный путь или имя из PATH. */
  command: string;
}

/** Интерпретатор, подходящий диапазону; самый новый из подходящих. */
export async function findPython(
  wanted: string | undefined,
  deps: RuntimeDeps,
): Promise<{ best?: FoundPython; all: FoundPython[] }> {
  const candidates = await pythonCandidates(deps);
  const probed = await Promise.all(
    candidates.map(async (command): Promise<FoundPython | undefined> => {
      const version = parseVersion(await deps.exec(command, PY_PROBE, deps.env));
      return version ? { version, text: formatVersion(version), command } : undefined;
    }),
  );
  const all = probed.filter((item): item is FoundPython => Boolean(item));
  if (!wanted) return { all };
  const best = bestMatching(all, wanted);
  return { all, ...(best ? { best } : {}) };
}

/** Путь к интерпретатору внутри venv — один на систему, второго вида нет. */
export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}
