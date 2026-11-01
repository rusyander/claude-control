import type { KeysError, KeysErrorCode } from './keys.types.ts';

export type { KeysError, KeysErrorCode } from './keys.types.ts';

const CODES: readonly KeysErrorCode[] = [
  'not-encrypted',
  'decrypt-failed',
  'master-missing',
  'store-garbage',
];

/**
 * Ошибка пакета — английское сообщение и код. Русский текст пакету не принадлежит: панель
 * подставляет свой по коду (фасад `lib/secret-crypto`), ядро пишет код в причину факта.
 */
export function keysError(code: KeysErrorCode, message: string): KeysError {
  return Object.assign(new Error(message), { code });
}

export function isKeysError(error: unknown): error is KeysError {
  return (
    error instanceof Error && CODES.includes((error as { code?: unknown }).code as KeysErrorCode)
  );
}
