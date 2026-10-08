/** Состояния распознавания. 'finalizing' — стоп нажат, ждём финал речь→текст (onEnd). */
export type SpeechState = 'idle' | 'listening' | 'finalizing' | 'error' | 'unsupported';

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
