import type { KnobView } from '@agentdeck/contracts';

/** Числа списка: от min до max — выбирают, а не набирают. */
export function knobNumbers(knob: Pick<KnobView, 'min' | 'max'>): number[] {
  const numbers: number[] = [];
  for (let value = knob.min; value <= knob.max; value += 1) numbers.push(value);
  return numbers;
}
