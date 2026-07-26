import type { SpeechErrorKind } from './speech-provider';

/** Состояния распознавания. 'finalizing' — стоп нажат, ждём финал речь→текст (onEnd). */
export type SpeechState = 'idle' | 'listening' | 'finalizing' | 'error' | 'unsupported';

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
};

/** Ключ перевода для ошибки; null — про эту ошибку говорить не о чем. */
export function speechErrorMessageKey(kind: SpeechErrorKind | null): string | null {
  return kind === null ? null : (MESSAGE_KEYS[kind] ?? null);
}

/** Стоит ли вообще показывать ошибку (и, значит, задерживаться в 'error'). */
export function isReportableSpeechError(kind: SpeechErrorKind): boolean {
  return speechErrorMessageKey(kind) !== null;
}

/**
 * Состояние после onEnd.
 *
 * Регрессия: браузер после ошибки ('not-allowed', 'network') ВСЕГДА досылает
 * end, а обработчик безусловно ставил 'idle' — состояние пробегало
 * listening → error → idle, и об отказе в микрофоне никто не узнавал.
 * Поэтому 'error' переживает конец сессии: снимет его следующий старт.
 */
export function nextStateAfterEnd(prev: SpeechState, wantsMore: boolean): SpeechState {
  // Пауза в диктовке: сессию перезапускаем, слушать не переставали.
  if (wantsMore) return 'listening';
  return prev === 'error' ? 'error' : 'idle';
}
