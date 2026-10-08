import type { KeyStep } from './hotkeys.types';
import { parseStep } from './parseStep';

/**
 * Разбирает аккорд целиком: пробелы делят шаги последовательности. `g o` — два
 * шага подряд, `mod+k` — один шаг. Невалидные шаги отбрасываются, чтобы одна
 * опечатка в привязке не роняла остальные.
 */
export function parseChord(chord: string): KeyStep[] {
  return chord
    .trim()
    .split(/\s+/)
    .map(parseStep)
    .filter((step): step is KeyStep => step !== null);
}
