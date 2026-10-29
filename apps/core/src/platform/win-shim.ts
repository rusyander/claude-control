import path from 'node:path';

// Обёртки — файлы Windows: пути их целей собираются по правилам win32 на любой ОС, чтобы
// разбор проверялся и в контейнере Linux.
const { dirname, extname, resolve } = path.win32;

/**
 * Разбор обёрток npm/pnpm/yarn на Windows, чтобы запускать их цель БЕЗ оболочки
 * (09 §spawn, P54). `.cmd` без оболочки с Node 20.12.2 — EINVAL (CVE-2024-27980), а через
 * cmd.exe многострочный промпт обрезается на первом переводе строки с кодом 0, `%ИМЯ%`
 * подставляется из окружения (F13). Обёртка лишь зовёт `node <скрипт> %*` или нативный
 * бинарь — ту же цель ядро запускает само, и argv доходит как есть.
 *
 * Перенос `apps/server/src/lib/win-shim.ts` (формы `.cmd`, сняты с машины) + новые формы
 * `.ps1` (npm кладёт их рядом; на машине с `PATHEXT` без `.CMD` первым находится `.ps1`).
 * Узнаётся только то, что реально пишут генераторы; всё остальное — `undefined`, и
 * вызывающий ОТКАЗЫВАЕТ: угадывать смысл чужого батника хуже честного отказа.
 */

export interface ShimTarget {
  /** `node` — запустить node со скриптом; `native` — сам бинарь. */
  kind: 'node' | 'native';
  /** Для `native` — путь к бинарю; для `node` — путь к скрипту. */
  target: string;
  /** Флаги node перед скриптом. */
  nodeFlags: string[];
  /** `NODE_PATH`, который обёртка выставила бы сама (pnpm). */
  nodePath?: string;
}

const FLAGS = String.raw`((?:-[^\s"%^&|<>!]*\s+)*)`;
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
/** `$new_node_path="…"` обёртки pnpm `.ps1`; ветка не-Windows пишет POSIX-путь с `/`. */
const PS_NODE_PATH_SET = /^\$new_node_path\s*=\s*"([^"$\x60]*)"$/i;

const PS_TARGET = String.raw`([^"$\x60\r\n]+)`;
const PS_NODE = new RegExp(
  String.raw`^&\s+"(?:\$basedir/node\$exe|node\$exe)"\s+${FLAGS}"\$basedir/${PS_TARGET}"\s+\$args$`,
  'i',
);
const PS_NATIVE = new RegExp(String.raw`^&\s+"\$basedir/${PS_TARGET}"\s+\$args$`, 'i');

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^@/, ''))
    .filter(Boolean);
}

function flags(raw: string | undefined): string[] {
  return (raw ?? '').split(/\s+/).filter(Boolean);
}

function nativeTarget(
  dir: string,
  relative: string,
  isFile: (path: string) => boolean,
): ShimTarget | undefined {
  const binary = resolve(dir, relative.replace(/\//g, '\\'));
  const ext = extname(binary).toLowerCase();
  // Только то, что CreateProcess запускает сам; `.js` по ассоциации — не наше.
  if ((ext !== '.exe' && ext !== '.com') || !isFile(binary)) return undefined;
  return { kind: 'native', target: binary, nodeFlags: [] };
}

/** Разбор `.cmd`; `shimPath` — его полный путь (каталог даёт `%dp0%`). */
export function parseCmdShim(
  text: string,
  shimPath: string,
  isFile: (path: string) => boolean,
): ShimTarget | undefined {
  const dir = dirname(shimPath);
  const all = lines(text);
  const runs = all.filter((line) => /%\*$/.test(line));
  const dp0 = all.some((line) => /^SET dp0=%~dp0$/i.test(line));

  if (dp0 && runs.length === 1) {
    const prog = NPM_PROG.exec(runs[0] ?? '');
    const progs = all
      .map((line) => /^SET "_prog=([^"]*)"$/i.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
    const nodeOnly = progs.length > 0 && progs.every((p) => /^(?:%dp0%\\node\.exe|node)$/i.test(p));
    if (prog && nodeOnly) {
      const script = resolve(dir, prog[2] ?? '');
      return isFile(script)
        ? { kind: 'node', target: script, nodeFlags: flags(prog[1]) }
        : undefined;
    }
    const direct = NPM_DIRECT.exec(runs[0] ?? '');
    if (direct && progs.length === 0) return nativeTarget(dir, direct[1] ?? '', isFile);
    return undefined;
  }

  if (runs.length === 0 || runs.length > 2) return undefined;
  const parsed = runs.map((line) => LEGACY.exec(line));
  if (parsed.some((match) => !match)) return undefined;
  const [first] = parsed;
  if (!first || parsed.some((m) => m?.[1] !== first[1] || m?.[2] !== first[2])) return undefined;
  const script = resolve(dir, first[2] ?? '');
  if (!isFile(script)) return undefined;
  const nodePaths = all
    .map((line) => NODE_PATH_SET.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  if (all.some((line) => /NODE_PATH/i.test(line)) && nodePaths.length !== 1) return undefined;
  return {
    kind: 'node',
    target: script,
    nodeFlags: flags(first[1]),
    ...(nodePaths[0] !== undefined ? { nodePath: nodePaths[0] } : {}),
  };
}

/**
 * Разбор `.ps1` npm (cmd-shim): ветки `& "$basedir/node$exe" … $args` и `& "node$exe" …`
 * обязаны звать один скрипт с одними флагами; нативная цель — `& "$basedir/x.exe" $args`.
 * Строки `$input | & …` (ввод из конвейера) — те же цели, разбираются наравне.
 */
export function parsePs1Shim(
  text: string,
  shimPath: string,
  isFile: (path: string) => boolean,
): ShimTarget | undefined {
  const dir = dirname(shimPath);
  const all = lines(text);
  const runs = all
    .map((line) => line.replace(/^\$input\s*\|\s*/i, ''))
    .filter((line) => /^&\s/.test(line));
  if (runs.length === 0) return undefined;
  const nodes = runs.map((line) => PS_NODE.exec(line));
  if (nodes.every(Boolean)) {
    const [first] = nodes;
    if (!first || nodes.some((m) => m?.[1] !== first[1] || m?.[2] !== first[2])) return undefined;
    const script = resolve(dir, (first[2] ?? '').replace(/\//g, '\\'));
    if (!isFile(script)) return undefined;
    // NODE_PATH pnpm (F-115): ровно одно присваивание Windows-ветки, как у `.cmd`; иначе отказ.
    const nodePaths = all
      .map((line) => PS_NODE_PATH_SET.exec(line)?.[1])
      .filter((value): value is string => value !== undefined && !value.startsWith('/'));
    if (all.some((line) => /\$new_node_path\s*=/i.test(line)) && nodePaths.length !== 1)
      return undefined;
    return {
      kind: 'node',
      target: script,
      nodeFlags: flags(first[1]),
      ...(nodePaths[0] !== undefined ? { nodePath: nodePaths[0] } : {}),
    };
  }
  const natives = runs.map((line) => PS_NATIVE.exec(line));
  if (!natives.every(Boolean)) return undefined;
  const target = natives[0]?.[1] ?? '';
  if (natives.some((m) => m?.[1] !== target)) return undefined;
  return nativeTarget(dir, target, isFile);
}
