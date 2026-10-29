import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { currentOs, type OsKind } from '../os-kind.ts';
import { DEFAULT_RETRY, retryTransient, type RetryPolicy } from './retry.ts';

/**
 * Атомарная замена файла (09 §atomic replace / durability): пишем во временный файл рядом,
 * fsync файла, `rename` поверх цели с ограниченным повтором (Windows: EPERM/EBUSY от
 * сканеров), на POSIX — fsync каталога, иначе сама замена может не пережить отключение
 * питания. На Windows fsync каталога нет (открыть каталог как файл нельзя) — это названо, а не
 * спрятано: NTFS журналирует метаданные сам.
 *
 * Перенос из `apps/server/src/lib/safe-io/write.ts` (атомарная запись + повтор переименования),
 * переделанный под ядро: без копий конфигов и формы текста (журналы и снимки ядра — его
 * собственные файлы), с fsync и fsync каталога. Серверная копия живёт, пока её вызывающие не
 * переехали (долг миграции).
 */

export interface AtomicWriteOptions {
  /** Режим файла (POSIX; на Windows доступ задаёт ACL профиля). Не задан — режим цели, нет цели — 0644. */
  mode?: number;
  retry?: RetryPolicy;
  os?: OsKind;
  /** Подмена переименования — только для тестов отказов. */
  rename?: (from: string, to: string) => void;
}

let tmpCounter = 0;

export function fsyncDirectory(dir: string, os: OsKind = currentOs()): void {
  if (os === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const os = options.os ?? currentOs();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  tmpCounter += 1;
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter}`);
  const rename = options.rename ?? renameSync;
  // Режим не указан — замена держит режим цели (F-110): секрет 0600 после перезаписи не
  // становился бы читаемым всем (0644 по умолчанию).
  const kept = options.mode === undefined && os !== 'win32' ? existingMode(path) : undefined;
  try {
    const fd = openSync(tmp, 'wx', options.mode ?? kept ?? 0o644);
    try {
      if (kept !== undefined) fchmodSync(fd, kept);
      const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      let written = 0;
      while (written < buffer.length)
        written += writeSync(fd, buffer, written, buffer.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    retryTransient(() => rename(tmp, path), options.retry ?? DEFAULT_RETRY);
  } catch (error) {
    // Временный файл не остаётся рядом с журналом после отказа.
    rmSync(tmp, { force: true });
    throw error;
  }
  fsyncDirectory(dir, os);
}
