import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { snapshotDir } from '../../platform/resource-scan.ts';
import { fileSize, readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Отпечаток файла в момент `tool.result` (этап 8, F3/F4): по нему «перечитал неизменный файл»
 * отличается от «перечитал после правки». До 1 МиБ — sha256 содержимого; крупнее — `size:mtime`
 * без чтения (снимок хода не читает гигабайты). Размер — из stat, не из текста модели (P32).
 * Нечитаемый путь — отпечатка нет: предикат такое чтение не судит (недосрабатывание, не ложное).
 */

export const FP_READ_CAP = 1024 * 1024;

export interface FileFp {
  fp: string;
  sizeBytes: number;
}

export interface FileFpIo {
  size(path: string): Fact<number>;
  read(path: string): Fact<Buffer>;
  /** Время изменения (мс, с дробью) — только для файла крупнее потолка. */
  mtime(path: string): Fact<number>;
}

/** mtime через снимок каталога платформы (`node:fs` — только платформе); регистр как у тома. */
function mtimeOf(path: string): Fact<number> {
  const rows = snapshotDir(dirname(path));
  if (!('value' in rows)) return rows;
  const name = basename(path);
  const row =
    rows.value.find((r) => r.name === name) ??
    rows.value.find((r) => r.name.toLowerCase() === name.toLowerCase());
  return row && row.kind === 'file' ? { value: row.mtimeMs } : { absent: true };
}

export const PLATFORM_FP_IO: FileFpIo = {
  size: (path) => {
    try {
      return fileSize(path);
    } catch (error) {
      return { unknown: error instanceof Error ? error.message : String(error) };
    }
  },
  read: (path) => readBytesSync(path),
  mtime: mtimeOf,
};

export function fileFp(path: string, io: FileFpIo = PLATFORM_FP_IO): FileFp | null {
  if (path === '') return null;
  const size = io.size(path);
  if (!('value' in size)) return null;
  if (size.value > FP_READ_CAP) {
    const mtime = io.mtime(path);
    return 'value' in mtime
      ? { fp: `size:${size.value}:${mtime.value}`, sizeBytes: size.value }
      : null;
  }
  const bytes = io.read(path);
  if (!('value' in bytes)) return null;
  return {
    fp: `sha256:${createHash('sha256').update(bytes.value).digest('hex')}`,
    sizeBytes: bytes.value.length,
  };
}
