import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { absent, readFact, value } from '../../lib/facts/read-fact.ts';
import { fsyncDirectory } from './atomic-write.ts';
import {
  DEFAULT_RETRY,
  errorCode,
  READ_TRANSIENT_CODES,
  retryTransient,
  type RetryPolicy,
} from './retry.ts';

/**
 * Чтения и мелкие записи ядра поверх `node:fs` (09: файловые операции — только в платформе).
 * Каждое чтение — факт: «нет» — только когда путь прочитан и его нет (`throwIfNoEntry: false`),
 * любая ошибка — `unknown` (P44). Ни одного `absent` из `catch`.
 */

export function readTextFact(path: string): Promise<Fact<string>> {
  return readFact('core.file', () => {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats) return absent();
    return readFileSync(path, 'utf8');
  });
}

export interface ReadOptions {
  retry?: RetryPolicy;
  /** Подмена чтения — только для тестов отказов. */
  read?: (path: string) => Buffer;
}

/**
 * Синхронное чтение для открытия журнала: тот же контракт факта, без таймера. На Windows файл,
 * который в этот миг заменяет `rename` писателя или держит сканер, отвечает EPERM/EBUSY (P55:
 * 16 читателей снимка под заменой) — такие коды повторяются ограниченно, и только после
 * границы ответ «неизвестно». «Нет» — лишь когда путь прочитан и его нет.
 */
export function readBytesSync(path: string, options: ReadOptions = {}): Fact<Buffer> {
  const read = options.read ?? ((p: string) => readFileSync(p));
  try {
    return retryTransient(
      (): Fact<Buffer> => {
        const stats = statSync(path, { throwIfNoEntry: false });
        if (!stats) return absent();
        return value(read(path));
      },
      options.retry ?? DEFAULT_RETRY,
      READ_TRANSIENT_CODES,
    );
  } catch (error) {
    return { unknown: `${errorCode(error) || 'error'}: ${(error as Error).message}` };
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function listDir(path: string): Fact<string[]> {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return absent();
  try {
    return value(readdirSync(path));
  } catch (error) {
    return { unknown: `${errorCode(error) || 'error'}: ${(error as Error).message}` };
  }
}

/**
 * Создать файл, только если его нет (`wx`), с fsync файла и каталога. Ответ — `created` или
 * `exists`; прочие ошибки — наверх. Это единственная CAS-операция файловой системы, на
 * которой стоят аренда и замок procs.json (rename поверх цели условным не бывает).
 */
export function createExclusive(path: string, text: string, mode = 0o644): 'created' | 'exists' {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, 'wx', mode);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return 'exists';
    throw error;
  }
  try {
    const buffer = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < buffer.length)
      written += writeSync(fd, buffer, written, buffer.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
  return 'created';
}

/** Копия файла для резервных копий; цель — новый файл, повтор временных отказов. */
export function copyFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  retryTransient(() => copyFileSync(from, to), DEFAULT_RETRY);
}

/** Переименование каталога или файла с повтором временных отказов (Windows: антивирус, индексатор). */
export function renamePath(from: string, to: string, retry: RetryPolicy = DEFAULT_RETRY): void {
  retryTransient(() => renameSync(from, to), retry);
}

/**
 * Одна попытка без ожидания — для вызова из таймера: синхронный повтор блокировал бы цикл
 * событий ядра на сотни миллисекунд; отказ уходит наверх, вызывающий повторит на своём тике.
 */
export const SINGLE_ATTEMPT: RetryPolicy = {
  attempts: 1,
  delayMs: () => 0,
  sleep: () => undefined,
};

export function fileSize(path: string): Fact<number> {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return absent();
  return value(stats.size);
}
