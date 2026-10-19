import { realpathSync } from 'node:fs';

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

function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:)?[\\/]/.test(path);
}

export function resolveFrom(cwd: string, path: string): string {
  return canonical(isAbsolutePath(path) ? path : `${cwd}/${path}`);
}

/** Тот же путь под настоящим именем, если он есть на диске (8.3-имена Windows). */
export function real(path: string): string | undefined {
  try {
    return canonical(realpathSync.native(path));
  } catch {
    return undefined;
  }
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
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

/** Файлы-черновики по окончанию: журналы, временные, остатки слияния. */
const TEMP_FILE = /\.(log|tmp|temp|orig|rej|bak)$/i;

/**
 * Временный ли путь внутри копии: хоть один каталог от корня копии — из
 * пересоздаваемых, или сам файл — черновик. Корень копии временным не бывает.
 */
export function isTempInside(path: string, root: string): boolean {
  if (!within(path, root) || path === root) return false;
  const parts = path.slice(root.replace(/\/$/, '').length + 1).split('/');
  return parts.some((part) => TEMP_DIRS.has(part)) || TEMP_FILE.test(parts.at(-1) ?? '');
}

/**
 * Временный путь вне копии — только записанный как временный: `/tmp/…`,
 * `$TMPDIR/…`, `%TEMP%\…`. Каталог временных файлов, раскрытый в абсолютный
 * путь, сюда не относится: под ним живут и настоящие данные (копии в тестах,
 * распакованные проекты), а по тексту их не отличить.
 */
const TEMP_PREFIX =
  /^(\/tmp|\/var\/tmp|\$\{?(TMPDIR|TEMP|TMP)\}?|%(TEMP|TMP)%|\$env:(TEMP|TMP))[\\/][^\s]*[^\\/\s.]/i;

export function isTempOutside(text: string): boolean {
  if (!TEMP_PREFIX.test(text)) return false;
  // Подъём наверх и вторая подстановка уводят из временного каталога.
  const rest = text.replace(/^[^\\/]+/, '');
  return !/(^|[\\/])\.\.([\\/]|$)/.test(rest) && !/[$%`]/.test(rest);
}
