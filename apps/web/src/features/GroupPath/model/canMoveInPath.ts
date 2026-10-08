import type { PathEntry } from '@agentdeck/contracts';
import { topSlot } from './topSlot';

/** Можно ли сдвинуть: на краю пути стрелка гаснет, а не молча ничего не делает. */
export function canMoveInPath(entries: PathEntry[], id: string, delta: -1 | 1): boolean {
  const from = entries.findIndex((entry) => entry.kind === 'custom' && entry.step.id === id);
  if (from < 0) return false;
  return delta < 0 ? from - 2 >= topSlot(entries) : from + 1 < entries.length;
}
