import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { currentOs, envValue, pathDirs, type OsKind } from './os-kind.ts';
import { parseCmdShim, parsePs1Shim, type ShimTarget } from './win-shim.ts';

/**
 * Что именно исполнится (P25, P54): настоящий файл, который можно запустить без оболочки,
 * и argv перед аргументами вызывающего. Общий для любого CLI и любого инструмента:
 * имя и каталоги приносит вызывающий
 * (переходник CLI), здесь ни одного имени CLI нет.
 *
 * Порядок поиска — как у оболочки: ПЕРВЫЙ каталог PATH, где есть запускаемый кандидат,
 * выигрывает (F13: «stale CLI first in PATH» — сервер искал `.exe` во всех каталогах раньше
 * обёрток и мог взять старый бинарь из дальнего каталога). Внутри каталога Windows:
 * `.com`, `.exe`, `.bat` (отказ — нужен cmd.exe), `.cmd` (разбор), `.ps1` (разбор).
 * POSIX: исполняемый файл (шебанг-скрипт запускается напрямую, интерпретатор находит ядро).
 */

export type ExecKind = 'native' | 'node-script' | 'shim-native' | 'shim-node' | 'shebang';

export type Resolution =
  | {
      ok: true;
      kind: ExecKind;
      /** Что передать в spawn первым аргументом. */
      file: string;
      /** Аргументы перед argv вызывающего (флаги node, путь к скрипту). */
      prefix: string[];
      /** Что нашлось на диске (обёртка или сам файл). */
      found: string;
      /** Добавка к окружению, которую сделала бы обёртка (`NODE_PATH` pnpm). */
      envAdd?: Record<string, string>;
    }
  | { ok: false; absent: true; searched: string[] }
  | { ok: false; absent: false; refused: string; found: string };

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  os?: OsKind;
  /** Каталоги после PATH (данные переходника: `~/.local/bin`, глобальный npm …). */
  extraDirs?: readonly string[];
  /** Только каталоги `extraDirs`, без PATH. */
  skipPath?: boolean;
  /**
   * Каталог, от которого считается явный относительный путь (`./gradlew`) — cwd запуска, как у
   * execvp после chdir. Без него — каталог процесса ядра: команда репозитория искалась бы не в копии.
   */
  cwd?: string;
}

/**
 * Выход из отказа обёртке (A2-F03, решение владельца): оболочки у ядра не будет, поэтому причина
 * сразу называет, что сделать человеку, — проверка тогда `no-verdict(env)`, а не загадка.
 */
const NO_SHELL =
  ' (no shell in the core): put the tool itself in PATH (gradle, mvn, …) or run the wrapper yourself';

const WIN_ORDER = ['.com', '.exe', '.bat', '.cmd', '.ps1'] as const;
const NODE_SCRIPT = new Set(['.js', '.mjs', '.cjs']);

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(file: string): boolean {
  if (!isFile(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * node, которым запускаются node-скрипты: рядом с обёрткой, иначе с PATH, иначе свой. На PATH
 * ищется только НАСТОЯЩИЙ `node.exe` (F-115): общий поиск разбирал бы обёртку `node.cmd`, её
 * разбор снова звал бы `nodeFor` — рекурсия до переполнения стека.
 */
function nodeFor(dir: string | undefined, env: NodeJS.ProcessEnv, os: OsKind): string {
  if (os === 'win32') {
    for (const candidate of [...(dir ? [dir] : []), ...pathDirs(env, os)]) {
      const near = path.win32.join(candidate, 'node.exe');
      if (isFile(near)) return near;
    }
    return process.execPath;
  }
  const found = resolveExecutable('node', { env, os });
  return found.ok && found.kind === 'native' ? found.file : process.execPath;
}

function fromShim(shim: ShimTarget, found: string, env: NodeJS.ProcessEnv, os: OsKind): Resolution {
  if (shim.kind === 'native')
    return { ok: true, kind: 'shim-native', file: shim.target, prefix: [], found };
  const current = envValue(env, 'NODE_PATH', os);
  return {
    ok: true,
    kind: 'shim-node',
    file: nodeFor(path.win32.dirname(found), env, os),
    prefix: [...shim.nodeFlags, shim.target],
    found,
    ...(shim.nodePath !== undefined
      ? { envAdd: { NODE_PATH: current ? `${shim.nodePath};${current}` : shim.nodePath } }
      : {}),
  };
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Конкретный файл Windows → разрешение (или отказ с причиной). */
function windowsCandidate(file: string, env: NodeJS.ProcessEnv): Resolution | undefined {
  if (!isFile(file)) return undefined;
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.com')
    return { ok: true, kind: 'native', file, prefix: [], found: file };
  if (NODE_SCRIPT.has(ext)) {
    return {
      ok: true,
      kind: 'node-script',
      file: nodeFor(undefined, env, 'win32'),
      prefix: [file],
      found: file,
    };
  }
  if (ext === '.bat')
    return {
      ok: false,
      absent: false,
      refused: `batch file needs cmd.exe${NO_SHELL}`,
      found: file,
    };
  if (ext === '.cmd' || ext === '.ps1') {
    const text = readText(file);
    const shim =
      text === undefined
        ? undefined
        : ext === '.cmd'
          ? parseCmdShim(text, file, isFile)
          : parsePs1Shim(text, file, isFile);
    if (shim) return fromShim(shim, file, env, 'win32');
    return {
      ok: false,
      absent: false,
      refused: `unrecognised ${ext} wrapper (would need a shell)${NO_SHELL}`,
      found: file,
    };
  }
  return undefined;
}

function windowsInDir(dir: string, name: string, env: NodeJS.ProcessEnv): Resolution | undefined {
  const ext = path.win32.extname(name).toLowerCase();
  if (ext && ([...WIN_ORDER] as string[]).concat([...NODE_SCRIPT]).includes(ext)) {
    return windowsCandidate(path.win32.join(dir, name), env);
  }
  for (const candidate of WIN_ORDER) {
    const hit = windowsCandidate(path.win32.join(dir, `${name}${candidate}`), env);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Первые байты файла через дескриптор (F-61): ради `#!` весь CLI (сотни МБ) не читается — а файл
 * больше предела строки V8 (~512 МБ) при чтении целиком падал, и шебанг-скрипт сходил за бинарь.
 */
function readHead(file: string, bytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const got = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, got).toString('latin1');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function posixCandidate(file: string): Resolution | undefined {
  if (!isExecutableFile(file)) return undefined;
  const head = readHead(file, 2);
  const kind: ExecKind = head === '#!' ? 'shebang' : 'native';
  return { ok: true, kind, file, prefix: [], found: file };
}

export function resolveExecutable(command: string, options: ResolveOptions = {}): Resolution {
  const os = options.os ?? currentOs();
  const env = options.env ?? process.env;
  const p = os === 'win32' ? path.win32 : path.posix;
  const explicit =
    p.isAbsolute(command) || command.includes('/') || (os === 'win32' && command.includes('\\'));

  if (explicit) {
    const file = options.cwd === undefined ? p.resolve(command) : p.resolve(options.cwd, command);
    if (os !== 'win32')
      return posixCandidate(file) ?? { ok: false, absent: true, searched: [file] };
    const hit = windowsInDir(p.dirname(file), p.basename(file), env);
    return hit ?? { ok: false, absent: true, searched: [file] };
  }

  const dirs = [...(options.skipPath ? [] : pathDirs(env, os)), ...(options.extraDirs ?? [])];
  for (const dir of dirs) {
    const hit =
      os === 'win32' ? windowsInDir(dir, command, env) : posixCandidate(p.join(dir, command));
    if (hit) return hit;
  }
  return { ok: false, absent: true, searched: dirs };
}
