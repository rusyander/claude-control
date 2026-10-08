import type { VoiceView } from './voiceInput.types';

/** Идёт запись или её финализация — отправка ждёт текста, который ещё не в поле. */
export function isDictating(view: VoiceView): boolean {
  return view === 'listening' || view === 'finalizing';
}
