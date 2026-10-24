import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Путь в одном виде для сравнения: прямые косые, `/c/` → `c:/`, без `.` и `..`. */
export function canonical(path: string): string {
  let text = path.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(\/|$)/.exec(text);
    if (msys) text = `${msys[1]}:/${text.slice(3)}`;
  }
  const drive = /^[a-zA-Z]:/.exec(text)?.[0];
  const rest = drive ? text.slice(2) : text;
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const joined = `${drive ? drive.toLowerCase() : ''}/${parts.join('/')}`;
  // Буквы пути на Windows регистра не различают.
  return drive ? joined.toLowerCase() : joined;
}

/** `C:dist` — тоже от корня диска, как у MSYS (`walk.ts` `isAbsolute`). */
function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:|[\\/])/.test(path);
}

export function resolveFrom(cwd: string, path: string): string {
  return canonical(isAbsolutePath(path) ? path : `${cwd}/${path}`);
}

/** Метки ссылок MSYS/Cygwin: файл `!<symlink>…` (`winsymlinks:sys`) и ярлык `x.lnk` (`:lnk`). */
const MSYS_LINKS: [suffix: string, magic: string][] = [
  ['', '!<symlink>'],
  ['.lnk', 'L\0\0\0'],
];

/**
 * Ссылка, которую видят только `rm`/`bash` Git Bash (RF-BGCD-04, 24.10): с
 * `MSYS=winsymlinks:sys|lnk` `ln -s` и `tar -x` пишут обычный файл с меткой,
 * `realpath` его ссылкой не считает, а `rm -rf D/l/*` идёт по нему наружу
 * (проверено на этой машине: файлы цели удалены).
 */
export function msysLink(path: string): boolean {
  if (process.platform !== 'win32') return false;
  for (const [suffix, magic] of MSYS_LINKS) {
    try {
      const file = `${path}${suffix}`;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 65_536) continue;
      const head = Buffer.alloc(magic.length);
      const fd = openSync(file, 'r');
      try {
        readSync(fd, head, 0, head.length, 0);
      } finally {
        closeSync(fd);
      }
      if (head.toString('latin1') === magic) return true;
    } catch {
      // Нет файла или не прочесть — не ссылка MSYS.
    }
  }
  return false;
}

/** Путь или любой его предок — ссылка MSYS: куда он ведёт, `realpath` не скажет. */
export function msysThrough(path: string): boolean {
  if (process.platform !== 'win32') return false;
  for (let probe = path; /\/[^/]/.test(probe); probe = probe.slice(0, probe.lastIndexOf('/'))) {
    if (msysLink(probe)) return true;
  }
  return false;
}

/** Тот же путь под настоящим именем, если он есть на диске (8.3-имена Windows). */
export function real(path: string): string | undefined {
  try {
    return canonical(realpathSync.native(path));
  } catch {
    return undefined;
  }
}

/**
 * Настоящий путь ближайшего существующего предка с хвостом, которого ещё нет:
 * `meta/hooks/x`, где `meta` — связка на `.git`, — это `…/.git/hooks/x`.
 */
export function realBelow(path: string): string | undefined {
  for (let probe = path; /\/[^/]/.test(probe); probe = probe.slice(0, probe.lastIndexOf('/'))) {
    const found = real(probe);
    if (found !== undefined) return `${found}${path.slice(probe.length)}`;
  }
  return undefined;
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
}

/** Сегмент шаблона оболочки: `*`, `?`, `[…]`. */
const GLOB_PART = /[*?[]/;

/**
 * Путь под `base` уходит из него по ссылке, заведённой раньше (RF-BGCD-04):
 * настоящий путь ближайшего существующего предка лежит вне настоящего `base`.
 * Сверяется предок первого шаблонного сегмента (`l/*` — сама `l`), а сама цель —
 * только когда действие идёт по ней (`follow`): `rm -rf l` убирает лишь ссылку.
 * Пути без `base` на диске не судим — сверять не с чем.
 */
export function escapesBase(path: string, base: string, follow: boolean): boolean {
  const root = canonical(base);
  const actual = real(root);
  if (!actual) return false;
  const parts = path.split('/');
  const glob = parts.findIndex((part) => GLOB_PART.test(part));
  let probe =
    glob >= 0 ? parts.slice(0, glob).join('/') : follow ? path : parts.slice(0, -1).join('/');
  while (probe !== root && within(probe, root)) {
    if (msysLink(probe)) return true;
    const resolved = real(probe);
    if (resolved) return !within(resolved, actual);
    probe = probe.slice(0, probe.lastIndexOf('/'));
  }
  return false;
}

/**
 * Каталоги внутри копии, которые сборка и проверки пересоздают сами, и
 * рабочая папка агента: удалить их — уборка, а не потеря данных (политика
 * владельца 19.10: карточка — только на удаление НЕвременного).
 */
const TEMP_DIRS = new Set([
  'tmp',
  'temp',
  '.tmp',
  '.temp',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.next',
  '.nuxt',
  '.vite',
  '.svelte-kit',
  '.parcel-cache',
  'test-results',
  'playwright-report',
  'blob-report',
  'storybook-static',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.eslintcache',
]);

/** Файлы-черновики по окончанию: журналы, временные, остатки слияния, байткод. */
const TEMP_FILE = /\.(log|tmp|temp|orig|rej|bak|pyc|pyo)$/i;
/** Временное по имени: `tmp-run.json`, `.tmp_x`, `temp.txt`. */
const TEMP_BASENAME = /^\.?(tmp|temp)[-_.]/i;

/** Имя каталога или файла само говорит, что оно временное. */
export function isTempName(name: string): boolean {
  return TEMP_DIRS.has(name) || TEMP_BASENAME.test(name);
}

/**
 * Временный ли путь внутри копии: хоть один каталог от корня копии — из
 * пересоздаваемых или назван временным, или сам файл — черновик. Корень копии
 * временным не бывает.
 */
export function isTempInside(path: string, root: string): boolean {
  if (!within(path, root) || path === root) return false;
  const parts = path.slice(root.replace(/\/$/, '').length + 1).split('/');
  return parts.some(isTempName) || TEMP_FILE.test(parts.at(-1) ?? '');
}

/** Шаблон имени `find -name`, под который попадает только временное: `*.log`, `__pycache__`. */
export function isTempPattern(pattern: string): boolean {
  return isTempName(pattern) || (/^\*\.[\w]+$/.test(pattern) && TEMP_FILE.test(pattern));
}

/**
 * Рабочая папка Claude Code вне копии: `<TEMP>/claude/<проект>/<сессия>/scratchpad`.
 * Её создаёт и чистит сам CLI, настоящих данных там нет.
 */
const SCRATCHPAD = /\/(temp|tmp)\/claude\/[^/]+\/[0-9a-f-]{36}\/scratchpad(\/|$)/i;

export function isScratchpad(path: string): boolean {
  return SCRATCHPAD.test(path);
}

/** Корень рабочей папки CLI, под которой лежит путь. */
export function scratchpadRoot(path: string): string | undefined {
  const match = SCRATCHPAD.exec(path);
  return match ? path.slice(0, match.index + match[0].length).replace(/\/$/, '') : undefined;
}

/**
 * Записанный временный путь (`/tmp/x`, `$TMPDIR/x`, `%TEMP%\x`) на диске и его
 * временный каталог: `/tmp` Git Bash на Windows — временный каталог системы.
 * `undefined` — переменная не задана: на диске не найти.
 */
export function tempOnDisk(text: string): { path: string; base: string } | undefined {
  const system = /^(\/tmp|\/var\/tmp)(?=[\\/]|$)/i.exec(text);
  let base: string;
  let rest: string;
  if (system) {
    const name = (system[1] as string).toLowerCase();
    base = name === '/tmp' && process.platform === 'win32' ? tmpdir() : name;
    rest = text.slice(system[0].length);
  } else {
    const variable = tempVariable(text);
    const value = variable === undefined ? undefined : process.env[variable];
    if (!value) return undefined;
    base = value;
    rest = text.replace(/^[^\\/]+/, '');
  }
  return { path: canonical(`${base}/${rest}`), base: canonical(base) };
}

/** Временный путь уходит из временного каталога по ссылке, заведённой раньше (RF-BGCD-04). */
export function leavesTemp(text: string): boolean {
  const disk = tempOnDisk(text);
  return disk !== undefined && escapesBase(disk.path, disk.base, true);
}

/**
 * Временный путь вне копии — только записанный как временный: `/tmp/…`,
 * `$TMPDIR/…`, `%TEMP%\…`. Каталог временных файлов, раскрытый в абсолютный
 * путь, сюда не относится: под ним живут и настоящие данные (копии в тестах,
 * распакованные проекты), а по тексту их не отличить.
 *
 * Это место ЗАПИСИ (`> /tmp/x.log`), а не уборки: удалить в `/tmp` группа
 * может только своё — созданное `mktemp` в этой же команде (решение владельца
 * 23.10, F-77), см. `targetKind`.
 */
const TEMP_PREFIX =
  /^(\/tmp|\/var\/tmp|\$\{?(TMPDIR|TEMP|TMP)\}?|%(TEMP|TMP)%|\$env:(TEMP|TMP))[\\/][^\s]*[^\\/\s.]/i;
/** Переменная в начале пути: `$TMPDIR` оболочки — с регистром, `%temp%` и `$env:temp` — без. */
const TEMP_VARIABLE = /^(?:\$\{?(TMPDIR|TEMP|TMP)\}?|%(temp|tmp)%|\$env:(temp|tmp))(?=[\\/])/i;

/** Имя переменной временного каталога, с которой начинается путь: `$TMPDIR/x` → `TMPDIR`. */
export function tempVariable(text: string): string | undefined {
  const match = TEMP_VARIABLE.exec(text);
  if (!match) return undefined;
  const [, posix, cmd, pwsh] = match;
  // `$tmpdir` в bash — другая переменная, чем `$TMPDIR`: пустая.
  if (posix !== undefined) return /^\$\{?[A-Z]+\}?/.test(match[0]) ? posix : '\0';
  return (cmd ?? pwsh ?? '').toUpperCase();
}

export function isTempOutside(text: string): boolean {
  if (!TEMP_PREFIX.test(text)) return false;
  // F-14: `$TMPDIR` не задан — `$TMPDIR/home/u` раскроется в `/home/u`. Задан ли он
  // у CLI, панель знает только по своему окружению (CLI его наследует).
  const variable = tempVariable(text);
  if (variable !== undefined && !process.env[variable]) return false;
  // Подъём наверх и вторая подстановка уводят из временного каталога.
  const rest = text.replace(/^[^\\/]+/, '');
  return !/(^|[\\/])\.\.([\\/]|$)/.test(rest) && !/[$%`]/.test(rest);
}
