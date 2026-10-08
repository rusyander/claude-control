import type { PathEntry } from '@agentdeck/contracts';

/** Сколько шагов у группы сверх встроенных стадий — число на карточке. */
export function ownStepCount(entries: PathEntry[]): number {
  return entries.filter((entry) => entry.kind !== 'builtin').length;
}
