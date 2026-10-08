import type { KnobView } from '@agentdeck/contracts';
import { isAutoKnob } from './knobs';

/**
 * Закреплённое число вне min..max: после новой выписки скилла размах мог
 * сузиться, а значение группы сервер не трогает — прогон берёт его как есть.
 * Список обязан его показать; без своего пункта select молча показывал «Авто».
 */
export function knobOutOfRange(knob: KnobView): number | undefined {
  if (isAutoKnob(knob)) return undefined;
  return knob.value < knob.min || knob.value > knob.max ? knob.value : undefined;
}
