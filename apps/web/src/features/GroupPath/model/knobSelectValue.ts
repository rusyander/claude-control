import type { KnobView } from '@agentdeck/contracts';
import { KNOB_AUTO } from './knobs.constants';
import { isAutoKnob } from './knobs';

/** Значение списка для числа: «Авто» или закреплённое число строкой. */
export function knobSelectValue(knob: KnobView): string {
  return isAutoKnob(knob) ? KNOB_AUTO : String(knob.value);
}
