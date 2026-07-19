import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';

/**
 * Файловые операции с двумя страховками, потому что мы правим рабочий конфиг
 * живого инструмента: испорченный settings.json ломает Claude Code целиком.
 *
 *   1. Резервная копия перед каждой записью — в claude-control/backups/.
 *   2. Атомарная запись: пишем во временный файл и переименовываем.
 *      Прерванная запись не оставит обрезанный конфиг.
 */

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

export function readTextFile(path: string, fallback = ''): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : fallback;
}

export interface WriteOptions {
  /** Куда складывать резервные копии. Пусто — не делать копий. */
  backupDir?: string;
}

export function writeTextFile(
  path: string,
  content: string,
  options: WriteOptions = {},
): string | undefined {
  const backupPath = options.backupDir ? makeBackup(path, options.backupDir) : undefined;
  mkdirSync(dirname(path), { recursive: true });

  // Временный файл лежит рядом с целевым: переименование в пределах одного тома атомарно.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);

  return backupPath;
}

export function writeJsonFile(
  path: string,
  data: unknown,
  options: WriteOptions = {},
): string | undefined {
  return writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, options);
}

/**
 * Копия с отметкой времени. Timestamp без двоеточий — иначе имя невалидно в Windows.
 */
function makeBackup(path: string, backupDir: string): string | undefined {
  if (!existsSync(path)) return undefined;
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupDir, `${basename(path)}.${stamp}.bak`);
  copyFileSync(path, target);
  return target;
}

/** Проверка, что строка — валидный JSON. Используется до записи, чтобы не портить конфиг. */
export function assertValidJson(raw: string): void {
  try {
    JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Невалидный JSON: ${detail}`);
  }
}
