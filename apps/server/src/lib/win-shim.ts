import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { resolveWindowsExecutable } from './win-exec.ts';

/**
 * Разбор `.cmd`-обёртки менеджера пакетов на Windows — чтобы запускать её цель
 * БЕЗ cmd.exe.
 *
 * Зачем: CLI, поставленный npm без нативного бинаря (qwen и т. п.), — это только
 * `qwen.cmd`, а через cmd.exe многострочный промпт обрезается на первой строке,
 * `%ИМЯ%` подставляется из окружения. Но такая обёртка всего лишь зовёт
 * `node <скрипт> %*` — значит, тот же node с тем же скриптом можно запустить
 * напрямую, и argv дойдёт как есть.
 *
 * Узнаём только формы, которые реально пишут генераторы (сняты с этой машины):
 * - npm (cmd-shim): `"%_prog%" [флаги] "%dp0%\<скрипт>" %*` при `_prog` =
 *   `%dp0%\node.exe` или `node`; и `"%dp0%\<бинарь>.exe" %*` для нативной цели;
 * - pnpm (@zkochan/cmd-shim) и старый npm: `"%~dp0\node.exe" … %*` / `node … %*`,
 *   у pnpm ещё `NODE_PATH`, который мы переносим в окружение;
 * - yarn: `node "%~dp0\yarn.js" %*`.
 * Всё остальное — undefined, и вызывающий идёт прежней дорогой через cmd.exe:
 * угадывать смысл чужого батника хуже, чем честно отказать.
 */

export interface ShimTarget {
  /** Что запускать без оболочки: node или нативный бинарь. */
  file: string;
  /** Аргументы перед argv вызывающего: флаги node и путь к скрипту. */
  prefix: string[];
  /** `NODE_PATH`, который обёртка выставила бы сама (pnpm), или undefined. */
  nodePath?: string;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Файл обёртки, который выбрал бы cmd.exe: первый каталог PATH, где есть
 * `<имя>.bat` или `<имя>.cmd` (PATHEXT по умолчанию — `.bat` раньше `.cmd`).
 * Разбираем только `.cmd`: в первом найденном каталоге `.bat` значит «не наша».
 */
function findShim(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const ext = extname(command).toLowerCase();
  const bare = ext === '.cmd' || ext === '.bat' ? command.slice(0, -ext.length) : command;

  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (ext === '.bat') return undefined;
    const path = ext === '.cmd' ? command : `${bare}.cmd`;
    return isFile(path) ? path : undefined;
  }

  const name = basename(bare);
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (isFile(join(dir, `${name}.bat`))) return undefined;
    const path = join(dir, `${name}.cmd`);
    if (isFile(path)) return path;
  }
  return undefined;
}

/** Флаги node из шебанга: только простые `-x`/`--y=z`, ничего, что cmd.exe развернул бы. */
const FLAGS = String.raw`((?:-[^\s"%^&|<>!]*\s+)*)`;
/** Путь цели относительно каталога обёртки: без `%`, кавычек и метасимволов cmd. */
const TARGET = String.raw`([^"%^&|<>!\r\n]+)`;

const NPM_PROG = new RegExp(
  String.raw`(?:^|&\s*)"%_prog%"\s+${FLAGS}"%dp0%\\${TARGET}"\s+%\*$`,
  'i',
);
const NPM_DIRECT = new RegExp(String.raw`^"%dp0%\\${TARGET}"\s+%\*$`, 'i');
const LEGACY = new RegExp(
  String.raw`^(?:"%~dp0\\node\.exe"|node)\s+${FLAGS}"%~dp0\\${TARGET}"\s+%\*$`,
  'i',
);
const NODE_PATH_SET = /^SET "NODE_PATH=([^"%]*)"$/i;

/** Строки батника без `@` в начале и без пустых. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^@/, ''))
    .filter(Boolean);
}

function flags(raw: string | undefined): string[] {
  return (raw ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Какой node запустила бы обёртка: `node.exe` рядом с ней, иначе `node` с PATH.
 * Не нашёлся и на PATH — тот же node, что у сервера: обёртка без node всё равно
 * не заработала бы, а сервер заведомо на нём живёт.
 */
function nodeFor(dir: string, env: NodeJS.ProcessEnv): string {
  const near = join(dir, 'node.exe');
  if (isFile(near)) return near;
  return resolveWindowsExecutable('node', env) ?? process.execPath;
}

export function resolveWindowsShim(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ShimTarget | undefined {
  const shim = findShim(command, env);
  if (!shim) return undefined;

  let text: string;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }
  const dir = dirname(shim);
  const all = lines(text);
  const runs = all.filter((line) => /%\*$/.test(line));

  // npm: `dp0` обязан быть ровно `%~dp0`, иначе `%dp0%` значит неизвестно что.
  const dp0 = all.some((line) => /^SET dp0=%~dp0$/i.test(line));

  if (dp0 && runs.length === 1) {
    const prog = NPM_PROG.exec(runs[0] ?? '');
    // `_prog` — только node: обёртка над `sh`/`bash` и прочим не наша.
    const progs = all
      .map((line) => /^SET "_prog=([^"]*)"$/i.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
    const nodeOnly = progs.length > 0 && progs.every((p) => /^(?:%dp0%\\node\.exe|node)$/i.test(p));
    if (prog && nodeOnly) {
      const script = resolve(dir, prog[2] ?? '');
      if (!isFile(script)) return undefined;
      return { file: nodeFor(dir, env), prefix: [...flags(prog[1]), script] };
    }

    const direct = NPM_DIRECT.exec(runs[0] ?? '');
    if (direct && progs.length === 0) {
      const binary = resolve(dir, direct[1] ?? '');
      const ext = extname(binary).toLowerCase();
      // Только то, что CreateProcess запускает сам; `.js` по ассоциации — не наше.
      if ((ext !== '.exe' && ext !== '.com') || !isFile(binary)) return undefined;
      return { file: binary, prefix: [] };
    }
    return undefined;
  }

  // pnpm / старый npm / yarn: одна или две ветки (node.exe рядом / node), и обе
  // обязаны звать один и тот же скрипт с одними и теми же флагами.
  if (runs.length === 0 || runs.length > 2) return undefined;
  const parsed = runs.map((line) => LEGACY.exec(line));
  if (parsed.some((match) => !match)) return undefined;
  const [first] = parsed;
  if (!first || parsed.some((m) => m?.[1] !== first[1] || m?.[2] !== first[2])) return undefined;

  const script = resolve(dir, first[2] ?? '');
  if (!isFile(script)) return undefined;

  // NODE_PATH: литерал из ветки «не задан»; в ветке «задан» pnpm дописывает
  // `;%NODE_PATH%` — это повторяет вызывающий. Иное содержимое — не наша обёртка.
  const nodePaths = all
    .map((line) => NODE_PATH_SET.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  const mentionsNodePath = all.some((line) => /NODE_PATH/i.test(line));
  if (mentionsNodePath && nodePaths.length !== 1) return undefined;

  return {
    file: nodeFor(dir, env),
    prefix: [...flags(first[1]), script],
    ...(nodePaths[0] !== undefined ? { nodePath: nodePaths[0] } : {}),
  };
}
