import type { KnobView } from '@agentdeck/contracts';

/** Подпись числа на языке интерфейса; пустая — ключ, чтобы поле не было безымянным. */
export function knobLabel(knob: KnobView, language: string): string {
  const own = language.startsWith('en') ? knob.label.en : knob.label.ru;
  const other = language.startsWith('en') ? knob.label.ru : knob.label.en;
  return own.trim() || other.trim() || knob.key;
}
