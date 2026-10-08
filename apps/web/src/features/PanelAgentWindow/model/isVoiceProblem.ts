import type { VoiceView } from './voiceInput.types';

/** Отказ, о котором строка под полем говорит как о проблеме (`role=alert`). */
export function isVoiceProblem(view: VoiceView): boolean {
  return (
    view === 'unsupported' ||
    view === 'denied' ||
    view === 'network' ||
    view === 'microphone' ||
    view === 'error'
  );
}
