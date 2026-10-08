import type { KeyStep } from './hotkeys.types';
import { stepsEqual } from './stepsEqual';

/**
 * Совпал ли хвост набранного буфера с искомой последовательностью. Буфер копит
 * последние нажатия; привязка срабатывает, когда её шаги легли ровно в конец —
 * так `g o` не мешает `o` в других сочетаниях, а `o` после паузы (буфер очищен)
 * не выстреливает половиной аккорда.
 */
export function matchSequence(buffer: readonly KeyStep[], steps: readonly KeyStep[]): boolean {
  if (steps.length === 0 || buffer.length < steps.length) return false;

  const offset = buffer.length - steps.length;
  for (let index = 0; index < steps.length; index += 1) {
    if (!stepsEqual(buffer[offset + index]!, steps[index]!)) return false;
  }
  return true;
}
