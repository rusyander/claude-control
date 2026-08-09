import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Токен доступа к API — единственный секрет, которым приложение на телефоне
 * доказывает, что оно своё.
 *
 * Лежит рядом с ручными учётными данными (`~/.claude-control/`), а НЕ в
 * `state.json`: настройки панель экспортирует и переносит между машинами, и
 * токен уехал бы вместе с ними. Файл, а не переменная окружения, потому что его
 * должен читать и прокси Vite — он на той же машине, но в другом процессе.
 */

const TOKEN_FILE = 'api-token';

export function apiTokenPath(): string {
  return join(homedir(), '.claude-control', TOKEN_FILE);
}

/**
 * Значение в памяти процесса: гейт спрашивает токен на КАЖДОМ запросе, а чтение
 * файла на каждый запрос — лишний поход в диск. Смена токена идёт через
 * `rotateApiToken`, то есть кэш обновляется там же, где меняется файл.
 */
let cached: string | undefined;

function write(token: string): string {
  const path = apiTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  cached = token;
  return token;
}

/**
 * Прочитать токен, создав его при первом обращении. Права 0600 Windows
 * игнорирует — там каталог профиля и так закрыт от других пользователей.
 */
export function readApiToken(): string {
  if (cached) return cached;
  const path = apiTokenPath();
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (value) {
      cached = value;
      return value;
    }
  }
  return write(randomBytes(32).toString('base64url'));
}

/** Новый токен вместо прежнего: все спаренные устройства придётся спарить заново. */
export function rotateApiToken(): string {
  return write(randomBytes(32).toString('base64url'));
}

/**
 * Сравнение за постоянное время: обычное `===` выходит из цикла на первом
 * несовпавшем байте, и по времени ответа токен подбирается посимвольно.
 */
export function isValidApiToken(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <токен>` или `?token=` — второе для потоков SSE. */
export function presentedToken(
  headerValue: string | undefined,
  query: unknown,
): string | undefined {
  if (typeof headerValue === 'string' && headerValue.startsWith('Bearer ')) {
    return headerValue.slice('Bearer '.length).trim();
  }
  if (query && typeof query === 'object' && 'token' in query) {
    const value = (query as { token?: unknown }).token;
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
