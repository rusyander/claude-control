import type { PathEntry, PathStep } from '@agentdeck/contracts';
import { moveToSlot } from './moveToSlot';
import { customSteps } from './pathEdit';

/**
 * Сдвинуть свой шаг на одну строку пути вверх или вниз — через шаг скилла,
 * стадию или соседний свой шаг. У края пути — тот же массив.
 */
export function moveInPath(entries: PathEntry[], id: string, delta: -1 | 1): PathStep[] {
  const from = entries.findIndex((entry) => entry.kind === 'custom' && entry.step.id === id);
  if (from < 0) return customSteps(entries);
  return moveToSlot(entries, id, delta < 0 ? from - 2 : from + 1);
}
