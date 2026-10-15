import { readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Удаление скачанного с диска: только внутри каталога моделей панели и без
 * подсчёта чужих байт как освобождённых.
 *
 * Пути файлов строятся из записей, которые читаются из `state.json` и каталога
 * (`repo`, имя файла, `imported.file`) и из тега в адресе запроса; запись,
 * исправленная руками, или тег с `..` увели бы `rm` за пределы каталога — в
 * хранилище Ollama человека или куда угодно. Поэтому каждый путь сверяется с
 * корнем ДО удаления, а не после.
 */

/** Путь лежит строго внутри каталога (сам каталог — нет). Сравнение после `resolve`, без обращения к диску. */
export function insideDir(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Один и тот же файл по пути: на Windows регистр букв не различается. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (path: string): string =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return norm(a) === norm(b);
}

/**
 * Сколько места вернёт удаление файла. Файл с другой жёсткой ссылкой (забранный
 * из Ollama) — 0: исчезнет только ссылка панели, байты остаются у Ollama.
 */
export function freesBytes(path: string): number {
  try {
    const info = statSync(path);
    return info.nlink > 1 ? 0 : info.size;
  } catch {
    return 0;
  }
}

/** Удалить файл и вернуть, сколько места это освободило. */
export function removeCounted(path: string): number {
  const freed = freesBytes(path);
  rmSync(path, { force: true });
  return freed;
}

/** Убрать опустевшие каталоги от `from` вверх, не выше `stop` (сам `stop` остаётся). */
export function pruneEmptyDirs(from: string, stop: string): void {
  for (let dir = from; insideDir(stop, dir); dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}
