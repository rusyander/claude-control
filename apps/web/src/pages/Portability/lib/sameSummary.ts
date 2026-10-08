import type { FidelityLevel } from '@agentdeck/contracts/portable-fidelity';
import { LEVEL_ORDER } from '@entities/Portability';

/** Совпали ли две сводки по всем уровням — сравнение по словарю, не по строке. */
export function sameSummary(
  left: Readonly<Record<FidelityLevel, number>>,
  right: Readonly<Record<FidelityLevel, number>>,
): boolean {
  return LEVEL_ORDER.every((level) => left[level] === right[level]);
}
