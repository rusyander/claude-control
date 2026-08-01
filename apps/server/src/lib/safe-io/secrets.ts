import { basename } from 'node:path';
import { encryptSecret } from '../secret-crypto.ts';

/**
 * Опциональное шифрование копий файла секретов `.mcp-secrets.env`.
 *
 * Копия этого файла по умолчанию лежит открытым текстом рядом с токенами.
 * Когда пользователь включает шифрование и вводит парольную фразу (держим её
 * только в памяти процесса, не в state.json), копии секретов пишутся
 * зашифрованными. Настройка и фраза приходят извне через сеттеры — так же,
 * как глубина ротации (`setBackupKeep`), чтобы safe-io не тянул contracts и
 * настройки в себя.
 */
let encryptSecretBackups = false;
let secretsBasename = '.mcp-secrets.env';
/** Парольная фраза — ТОЛЬКО в памяти, никогда на диск. Пусто — не задана. */
let secretPassphrase: string | undefined;

/** Включить/выключить шифрование копий файла секретов (из настроек панели). */
export function setEncryptSecretBackups(enabled: boolean): void {
  encryptSecretBackups = enabled;
}

/** Basename файла секретов — по нему backupEntry узнаёт, что копию надо шифровать. */
export function setSecretsBasename(name: string): void {
  if (name) secretsBasename = name;
}

/** Задать/сбросить парольную фразу шифрования копий секретов (память процесса). */
export function setSecretPassphrase(passphrase: string | undefined): void {
  secretPassphrase = passphrase;
}

/** Загружена ли парольная фраза в память сейчас (для подсказок в интерфейсе). */
export function hasSecretPassphrase(): boolean {
  return secretPassphrase !== undefined;
}

/** Файлы, чей режим обязан быть 0600 даже после пересоздания (см. applyFileMode). */
const SECRET_BASENAMES = new Set(['.credentials.json', 'provider-keys.enc', 'provider-keys.key']);

/** Секретный ли это файл по имени — по нему ставится режим 0600. */
export function isSecretFile(path: string): boolean {
  const name = basename(path);
  return name === secretsBasename || SECRET_BASENAMES.has(name) || name.endsWith('.env');
}

/** Эта копия — файла секретов? По basename исходного пути. */
export function isSecretsPath(path: string): boolean {
  return basename(path) === secretsBasename;
}

/**
 * Копию секретов сделать нельзя: шифрование включено, а парольной фразы в
 * памяти нет. Отдельный класс, чтобы вызывающий отличил «нечего копировать» от
 * «копия невозможна» и отказался от разрушающей записи, а не молча выполнил её.
 *
 * NB: поля не объявляем параметрами конструктора — сервер идёт под
 * `node --experimental-strip-types`, а там parameter properties валят старт.
 */
export class SecretBackupUnavailableError extends Error {
  constructor(message = SECRET_BACKUP_UNAVAILABLE) {
    super(message);
    this.name = 'SecretBackupUnavailableError';
  }
}

const SECRET_BACKUP_UNAVAILABLE =
  'Шифрование копий включено, но парольная фраза не введена: резервную копию файла секретов сделать нечем, ' +
  'а писать её открытым текстом нельзя. Введите фразу в разделе настроек и повторите — тогда правка будет обратима.';

/**
 * Надо ли шифровать копию этого пути. Шифрование включено, а фразы в памяти нет —
 * `SecretBackupUnavailableError`: копии не будет, значит и разрушающей записи тоже.
 * Спрашивается ДО mkdir и штампа, чтобы отказ не оставлял следов на диске.
 */
export function needsSecretEncryption(path: string): boolean {
  if (!isSecretsPath(path) || !encryptSecretBackups) return false;
  if (secretPassphrase === undefined) throw new SecretBackupUnavailableError();
  return true;
}

/** Зашифровать содержимое копии секретов фразой из памяти процесса. */
export function encryptSecretBackup(plaintext: string): Buffer {
  return encryptSecret(plaintext, secretPassphrase!);
}
