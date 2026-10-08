import type { SpeechErrorKind, SpeechState } from '@shared/lib/speech';
import type { VoiceView } from './voiceInput.types';

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
    if (error === 'no-microphone') return 'microphone';
    if (error === 'unsupported') return 'unsupported';
    return 'error';
  }
  return 'idle';
}
