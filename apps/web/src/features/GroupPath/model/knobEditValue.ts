import { KNOB_AUTO } from './knobs.constants';

/** Выбор в списке → тело PUT: `null` — вернуть «Авто», число — закрепить. */
export function knobEditValue(selected: string): number | null {
  if (selected === KNOB_AUTO) return null;
  const value = Number(selected);
  return Number.isInteger(value) ? value : null;
}
