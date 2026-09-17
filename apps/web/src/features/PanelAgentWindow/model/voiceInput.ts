import type { SpeechErrorKind, SpeechState } from '@shared/lib/speech';

/**
 * Что показывает микрофон окна агента. Состояние распознавателя общее с чатом
 * (`useSpeechRecognition`), а слова свои: окно называет ОТКАЗ по существу —
 * «нет разрешения» человек чинит в браузере, «не поддерживается» не чинит
 * ничем, и одна строка «не вышло» для обоих оставила бы его жать кнопку снова.
 */
export type VoiceView =
  'idle' | 'listening' | 'finalizing' | 'unsupported' | 'denied' | 'network' | 'error';

export interface VoiceInputState {
  state: SpeechState;
  supported: boolean;
  error: SpeechErrorKind | null;
  /** Человек уже нажимал микрофон: причину «не поддерживается» говорим после попытки. */
  attempted: boolean;
}

export function voiceView({ state, supported, error, attempted }: VoiceInputState): VoiceView {
  if (!supported || state === 'unsupported') return attempted ? 'unsupported' : 'idle';
  if (state === 'listening') return 'listening';
  if (state === 'finalizing') return 'finalizing';
  if (state === 'error') {
    if (error === 'no-permission') return 'denied';
    if (error === 'network') return 'network';
    if (error === 'unsupported') return 'unsupported';
    return 'error';
  }
  return 'idle';
}

/** Идёт запись или её финализация — отправка ждёт текста, который ещё не в поле. */
export function isDictating(view: VoiceView): boolean {
  return view === 'listening' || view === 'finalizing';
}

/** Отказ, о котором строка под полем говорит как о проблеме (`role=alert`). */
export function isVoiceProblem(view: VoiceView): boolean {
  return view === 'unsupported' || view === 'denied' || view === 'network' || view === 'error';
}

/**
 * Надиктованное ДОПИСЫВАЕТСЯ к набранному: часть фразы могла быть набрана
 * руками до микрофона. Отправки здесь нет и быть не должно — решает человек.
 */
export function appendDictation(current: string, heard: string): string {
  const text = heard.trim();
  if (!text) return current;
  const base = current.trimEnd();
  return base ? `${base} ${text}` : text;
}
