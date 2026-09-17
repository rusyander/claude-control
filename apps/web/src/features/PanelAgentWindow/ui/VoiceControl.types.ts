import type { VoiceView } from '../model/voiceInput';

export interface VoiceControlProps {
  /** Дописать распознанное в поле ввода; отправки здесь нет. */
  onDictated: (heard: string) => void;
  /** Ход агента идёт — микрофон не нужен, как и поле. */
  disabled?: boolean;
  /** Сообщить окну, что идёт диктовка: отправка ждёт текста в поле. */
  onViewChange?: (view: VoiceView) => void;
}
