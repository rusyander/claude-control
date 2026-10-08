import type { SpeechErrorKind } from './speech-provider';

/**
 * Ошибки, о которых человеку нужно сказать, и текст для каждой.
 *
 * Молчим только там, где молчание и есть обычный ход: тишина в эфире
 * ('no-speech' — им же провайдер помечает неизвестные коды) и обрыв по своей же
 * команде стоп ('aborted'). Остальное значит, что диктовка не поедет вовсе,
 * и без объяснения человек просто жмёт микрофон снова.
 */
const MESSAGE_KEYS: Partial<Record<SpeechErrorKind, string>> = {
  'no-permission': 'assistant.speechError.noPermission',
  network: 'assistant.speechError.network',
  unsupported: 'assistant.speechError.unsupported',
  'no-microphone': 'assistant.speechError.noMicrophone',
};

/** Ключ перевода для ошибки; null — про эту ошибку говорить не о чем. */
export function speechErrorMessageKey(kind: SpeechErrorKind | null): string | null {
  return kind === null ? null : (MESSAGE_KEYS[kind] ?? null);
}
