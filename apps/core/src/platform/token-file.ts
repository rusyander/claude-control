import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { currentOs, type OsKind } from './os-kind.ts';
import { writeFileAtomic } from './safe-io/atomic-write.ts';
import { createExclusive, readBytesSync } from './safe-io/files.ts';

/**
 * Токен ядра `<core home>/token` (00 §Processes, 09 §token file mode): им ходит только сервер
 * панели к ядру. POSIX — режим 0600, прочитанный назад. Windows — `chmod` там ничего не значит:
 * доступ к файлу задаёт ACL профиля пользователя (каталог `%USERPROFILE%` закрыт от других
 * учётных записей по умолчанию), это названо здесь и в отчёте, а не изображено режимом.
 * Создание — `wx`: два ядра, стартовавшие разом, не перезапишут токен друг друга.
 */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type TokenFileOutcome = {
  token: string;
  created: boolean;
  modeChecked: 'posix-0600' | 'windows-profile-acl';
};

/** Моложе этого файл неверной формы может ещё дописываться соседним ядром (`wx` + запись). */
const WRITER_WINDOW_MS = 2_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Файл есть, но формы токена нет (F-58: падение между `wx` и записью оставляет пустой или
 * обрезанный файл) — иначе каждый следующий старт падал бы на нём навсегда. Свежий файл сначала
 * дожидаемся (его мог создать соседнее ядро прямо сейчас), затем заменяем атомарно с 0600.
 */
function recoverBroken(path: string): boolean {
  const deadline = Date.now() + WRITER_WINDOW_MS;
  for (;;) {
    const read = readToken(path);
    if (!('unknown' in read) || !read.unknown.startsWith('garbage')) return false;
    const stats = statSync(path, { throwIfNoEntry: false });
    const young = stats !== undefined && Date.now() - stats.mtimeMs < WRITER_WINDOW_MS;
    if (!young || Date.now() >= deadline) break;
    sleepSync(50);
  }
  writeFileAtomic(path, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  return true;
}

export function ensureTokenFile(path: string, os: OsKind = currentOs()): TokenFileOutcome {
  const fresh = randomBytes(32).toString('base64url');
  const created = createExclusive(path, `${fresh}\n`, 0o600) === 'created' || recoverBroken(path);
  // Читается назад то, что на диске: при гонке двух восстановлений оба берут победившую замену.
  const read = readToken(path);
  if (!('value' in read))
    throw new Error(
      `core token unreadable: ${'unknown' in read ? read.unknown : 'absent after create'}`,
    );
  if (os !== 'win32') {
    // Файл мог прийти чужим режимом (копия, распаковка) — приводим и читаем назад.
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    if ((statSync(path).mode & 0o077) !== 0)
      throw new Error(`core token mode is not 0600: ${path}`);
  }
  return {
    token: read.value,
    created,
    modeChecked: os === 'win32' ? 'windows-profile-acl' : 'posix-0600',
  };
}

export function readToken(path: string): Fact<string> {
  const bytes = readBytesSync(path);
  if (!('value' in bytes)) return bytes;
  const token = bytes.value.toString('utf8').trim();
  return TOKEN_PATTERN.test(token)
    ? { value: token }
    : { unknown: 'garbage: token file has wrong form' };
}

/** Сравнение без утечки по времени. */
export function tokenEquals(expected: string, got: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
