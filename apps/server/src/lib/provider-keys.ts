import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { encryptSecret, decryptSecret } from './secret-crypto.ts';

/**
 * Хранилище API-ключей провайдеров на уровне панели (Ф6a).
 *
 * БЕЗОПАСНОСТЬ ПРЕЖДЕ ВСЕГО. Ключи НИКОГДА не пишутся в чужие конфиги провайдеров
 * и НИКОГДА не логируются. На диске лежат только ЗАШИФРОВАННО — в файле
 * `claude-control/provider-keys.enc` внутри appData панели. Наружу (в ответах
 * API) ключ отдаётся исключительно маскированным (`sk-…last4`) вместе со статусом.
 *
 * Шифрование переиспользует `secret-crypto.ts` (AES-256-GCM + scrypt). Парольная
 * фраза для него — машинно-локальный секрет, сгенерированный при первой записи и
 * сохранённый в отдельном файле `provider-keys.key` (права 0600, не входит ни в
 * бандл конфигурации, ни в снимок state.json, ни в резервные копии). Так файл
 * с ключами `.enc` сам по себе (например, при случайном копировании) бесполезен:
 * расшифровать его без ключевого файла нельзя, а открытого ключа он не содержит.
 *
 * FAIL-CLOSED на чтении: если `.enc` повреждён, а ключевой файл потерян/сменился
 * (расшифровка не сходится) — считаем хранилище пустым, а не роняем панель. Это
 * не раскрывает секретов и не мешает задать ключи заново.
 */

const KEYS_FILE = 'provider-keys.enc';
const MASTER_FILE = 'provider-keys.key';

/** Верхняя граница длины ключа — защита от абсурдного ввода (ключи короче). */
export const MAX_KEY_LENGTH = 8192;

type KeyStore = Record<string, string>;

/**
 * Машинно-локальная парольная фраза шифрования. При первом обращении генерируется
 * 256-битный случайный секрет и кладётся в `provider-keys.key` с правами 0600.
 * На последующих обращениях читается оттуда. На диск попадает только этот секрет
 * (не ключи), и он не выходит за пределы appData панели.
 */
function resolveMasterPassphrase(appDataDir: string): string {
  const path = join(appDataDir, MASTER_FILE);
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw) return raw;
  }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(path, secret, { encoding: 'utf8', mode: 0o600 });
  // На части ОС mode из writeFileSync игнорируется существующим umask — дожимаем.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Права не критичны для работы (Windows их не так трактует); не падаем.
  }
  return secret;
}

/**
 * Прочитать и расшифровать всё хранилище ключей. Нет файла → пусто. Повреждён/не
 * расшифровывается (потерян ключевой файл) → пусто (fail-closed, без падения).
 */
export function readKeyStore(appDataDir: string): KeyStore {
  const path = join(appDataDir, KEYS_FILE);
  if (!existsSync(path)) return {};
  try {
    const blob = readFileSync(path);
    const json = decryptSecret(blob, resolveMasterPassphrase(appDataDir));
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: KeyStore = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) store[id] = value;
    }
    return store;
  } catch {
    // Битый файл или чужой/утраченный ключ шифрования — трактуем как пустое
    // хранилище: секретов не раскрываем, работу панели не ломаем.
    return {};
  }
}

/**
 * Зашифровать и записать всё хранилище ключей.
 *
 * Запись АТОМАРНАЯ (временный файл рядом + rename): файл читается целиком и
 * fail-closed на повреждении, поэтому оборванная запись (падение/выключение
 * посреди `writeFileSync`) молча обнулила бы ВСЕ сохранённые ключи. Права 0600
 * ставятся ещё на временном файле — чтобы секрет ни мгновения не лежал открытым
 * для группы/остальных. Windows режимы posix игнорирует, там защита — ACL каталога.
 */
function writeKeyStore(appDataDir: string, store: KeyStore): void {
  const path = join(appDataDir, KEYS_FILE);
  mkdirSync(appDataDir, { recursive: true });
  const blob = encryptSecret(JSON.stringify(store), resolveMasterPassphrase(appDataDir));

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, blob, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // см. resolveMasterPassphrase — права best-effort.
  }
  renameSync(tmp, path);
}

/** Сохранённый в панели ключ провайдера (расшифрованный) или `undefined`. */
export function getStoredKey(appDataDir: string, providerId: string): string | undefined {
  return readKeyStore(appDataDir)[providerId];
}

/** Есть ли сохранённый в панели ключ провайдера (без раскрытия значения). */
export function hasStoredKey(appDataDir: string, providerId: string): boolean {
  return Boolean(readKeyStore(appDataDir)[providerId]);
}

/**
 * Сохранить ключ провайдера (зашифровано). Пустое значение — удаление. Возвращает
 * `false`, если ключ пуст или превышает предел длины (в файл не пишем).
 */
export function setStoredKey(appDataDir: string, providerId: string, key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    clearStoredKey(appDataDir, providerId);
    return true;
  }
  if (trimmed.length > MAX_KEY_LENGTH) return false;
  const store = readKeyStore(appDataDir);
  store[providerId] = trimmed;
  writeKeyStore(appDataDir, store);
  return true;
}

/** Удалить сохранённый ключ провайдера. Отсутствие ключа — не ошибка. */
export function clearStoredKey(appDataDir: string, providerId: string): void {
  const store = readKeyStore(appDataDir);
  if (!(providerId in store)) return;
  delete store[providerId];
  writeKeyStore(appDataDir, store);
}

/**
 * Маска ключа для показа в интерфейсе: первые символы + `…` + последние 4
 * (`sk-…1a2b`). Полный ключ наружу НИКОГДА не отдаётся. Короткие значения
 * маскируются сильнее, чтобы не раскрыть почти весь ключ.
 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return '';
  if (k.length <= 8) return `…${k.slice(-2)}`;
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}
