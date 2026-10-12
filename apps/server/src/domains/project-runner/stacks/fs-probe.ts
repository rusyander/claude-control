import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Чтение файлов проекта для детекторов стека. Всё без исключений наружу: битый
 * или недоступный файл значит «не узнали», а не падение списка целей.
 */

/** Самый большой файл, который детектор читает целиком: дальше — не исходник. */
const MAX_READ = 256 * 1024;

export function readText(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_READ) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Первый каталог от `dir` вверх до `root` включительно, где лежит один из
 * `names`. Выше корня проекта не смотрим: go.mod или uv.lock соседнего проекта
 * на диске к этому проекту отношения не имеют.
 */
export function findUp(dir: string, root: string, names: string[]): string | undefined {
  const top = resolve(root);
  let current = resolve(dir);
  for (;;) {
    if (names.some((name) => existsSync(join(current, name)))) return current;
    if (current === top) return undefined;
    const up = dirname(current);
    if (up === current) return undefined;
    // Каталог цели вне корня (не должно случаться) — дальше не идём.
    if (!up.startsWith(top)) return undefined;
    current = up;
  }
}

/** Путь относительно корня проекта, всегда с `/` — так его видит человек. */
export function relPath(root: string, path: string): string {
  return relative(root, path).split('\\').join('/') || '.';
}

/**
 * Путь к программе внутри проекта для показа: `./gradlew`, `.venv/bin/python`.
 * Относительно каталога запуска, с разделителем ОС — ровно то, что набрал бы
 * человек в терминале этого каталога.
 */
export function shownPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel.includes('\\') || rel.includes('/') || process.platform === 'win32' ? rel : `./${rel}`;
}

/** Склейка команды для показа: аргумент с пробелом — в кавычках. */
export function displayOf(file: string, args: string[]): string {
  return [file, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}
