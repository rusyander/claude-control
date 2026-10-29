import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { absent } from '../../lib/facts/read-fact.ts';
import { fsyncDirectory } from '../safe-io/atomic-write.ts';
import { readBytesSync } from '../safe-io/files.ts';
import { errorCode } from '../safe-io/retry.ts';
import { reasonOf } from '../os-kind.ts';

/**
 * Файлы хранилища записей проверок под `<common>/agentdeck-verify/` (04:33). Запись пишется один
 * раз: готовый временный файл становится записью жёсткой ссылкой — атомарно и без замены (rename
 * на Windows молча заменяет существующий файл, а «заменить запись» — значит переписать вердикт).
 */

/** Коды «ссылок здесь нет» (FAT, часть сетевых дисков) — там создание через `wx`. */
const LINK_UNSUPPORTED: ReadonlySet<string> = new Set([
  'EPERM',
  'ENOTSUP',
  'EXDEV',
  'ENOSYS',
  'EINVAL',
]);

function writeAll(path: string, data: Uint8Array, flag: 'wx'): void {
  const fd = openSync(path, flag, 0o644);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Создать файл, только если его нет: `exists` — имя занято, прочие сбои — исключение. */
export function createOnceLinked(file: string, data: Uint8Array): 'created' | 'exists' {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeAll(tmp, data, 'wx');
  try {
    try {
      linkSync(tmp, file);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST') return 'exists';
      if (!LINK_UNSUPPORTED.has(code)) throw error;
      // Без ссылок недописанный файл читатель увидит битым, а битая запись — промах, не зелёный.
      try {
        writeAll(file, data, 'wx');
      } catch (inner) {
        if (errorCode(inner) === 'EEXIST') return 'exists';
        throw inner;
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Оставшийся .tmp — не запись: читатель берёт только имена записей.
    }
  }
  fsyncDirectory(dirname(file));
  return 'created';
}

/** Байты файла хранилища: «нет» — только прочитанное отсутствие (P44). */
export function readStoreFile(path: string): Fact<Buffer> {
  return readBytesSync(path);
}

/** Имена каталога; нет каталога — «нет», сбой чтения — `unknown`. */
export function listStoreDir(dir: string): Fact<string[]> {
  let stats;
  try {
    stats = statSync(dir, { throwIfNoEntry: false });
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
  if (!stats) return absent();
  try {
    return { value: readdirSync(dir) };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}
