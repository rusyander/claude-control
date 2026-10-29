import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './files.ts';
import { fsyncDirectory } from './atomic-write.ts';

/**
 * Файл только для дописывания (журнал задачи, `beats.log`, `journal.rejected.jsonl`): строка
 * уходит одним `write` на дескриптор, открытый с O_APPEND (на Windows libuv открывает с
 * FILE_APPEND_DATA) — читатель видит строку целиком или не видит вовсе, кроме хвоста при
 * крахе посреди записи; такой хвост режется при открытии (`cutTornTail`). `sync()` — fsync
 * дескриптора: после него строка переживает отключение питания (09: на macOS libuv даёт
 * F_FULLFSYNC).
 */
export interface AppendLog {
  readonly path: string;
  append(line: Buffer): void;
  sync(): void;
  close(): void;
}

/**
 * Срезать файл до `size`. Windows не даёт `ftruncate` дескриптору дописывания (FILE_APPEND_DATA
 * без FILE_WRITE_DATA — EPERM, замер 28.10) — тогда по пути: свой дескриптор открыт с
 * разделением записи, а O_APPEND следующей строки сам встанет в новый конец.
 */
function rollback(fd: number, path: string, size: number): void {
  try {
    ftruncateSync(fd, size);
  } catch {
    truncateSync(path, size);
  }
}

export function openAppendLog(path: string): AppendLog {
  ensureDir(dirname(path));
  const existed = statSync(path, { throwIfNoEntry: false }) !== undefined;
  let fd: number | undefined = openSync(path, 'a');
  /** Откат частичной записи не удался: файл с рваным хвостом, дописывать после него нельзя. */
  let broken: unknown;
  // Новый файл — fsync каталога, иначе сама запись о файле может не пережить сбой (POSIX).
  if (!existed) fsyncDirectory(dirname(path));
  return {
    path,
    append(line) {
      if (fd === undefined) throw new Error(`append-log closed: ${path}`);
      if (broken !== undefined) throw new Error(`append-log broken after a failed write: ${path}`);
      const before = fstatSync(fd).size;
      try {
        let written = writeSync(fd, line);
        // Частичная запись на локальном диске почти не бывает; если бывает — дописываем остаток.
        while (written < line.length)
          written += writeSync(fd, line, written, line.length - written);
      } catch (error) {
        // Запись оборвалась посреди строки (ENOSPC, EIO): срезать её начало, иначе следующая
        // строка ляжет за рваным куском посреди файла (ревью M5). Не вышло — дальше не пишем:
        // рваный хвост срежет открытие (`cutTornTail`).
        try {
          rollback(fd, path, before);
        } catch (truncateError) {
          broken = truncateError;
        }
        throw error;
      }
    },
    sync() {
      if (fd !== undefined) fsyncSync(fd);
    },
    close() {
      if (fd === undefined) return;
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    },
  };
}

/**
 * Хвост без перевода строки — запись, прерванная крахом. Режется до последнего `\n`; ответ —
 * сколько байт срезано (0 — хвост целый). Вызывает только владелец аренды.
 */
export function cutTornTail(path: string): number {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats || stats.size === 0) return 0;
  const bytes = readFileSync(path);
  if (bytes[bytes.length - 1] === 0x0a) return 0;
  const keep = bytes.lastIndexOf(0x0a) + 1;
  truncateSync(path, keep);
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return bytes.length - keep;
}

/** Последние `maxBytes` файла — для чтения последнего удара сердца без чтения всего файла. */
export function readTail(path: string, maxBytes: number): Buffer | undefined {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return undefined;
  const start = Math.max(0, stats.size - maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(stats.size - start);
    let read = 0;
    while (read < buffer.length) {
      // Чтение с позицией не двигает общий указатель дескриптора.
      const got = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (got === 0) break;
      read += got;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
