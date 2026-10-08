import type { SpeechErrorKind } from './speech-provider';
import { speechErrorMessageKey } from './speech-state';

/** Стоит ли вообще показывать ошибку (и, значит, задерживаться в 'error'). */
export function isReportableSpeechError(kind: SpeechErrorKind): boolean {
  return speechErrorMessageKey(kind) !== null;
}
