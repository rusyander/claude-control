import type { PathEntry, PathStep } from '@agentdeck/contracts';
import { topSlot } from './topSlot';
import { insertAfter } from './insertAfter';
import { customSteps } from './pathEdit';

/**
 * Перенести свой шаг так, чтобы он встал сразу после строки `afterIndex`
 * (индекс в `entries` ДО переноса) — то, что делает перетаскивание. Место
 * считается по списку без самого шага, поэтому перенос через стадию или внутрь
 * скилла меняет и стадию, и `within`. Ничего не меняется — тот же массив.
 */
export function moveToSlot(entries: PathEntry[], id: string, afterIndex: number): PathStep[] {
  const steps = customSteps(entries);
  const from = entries.findIndex((entry) => entry.kind === 'custom' && entry.step.id === id);
  const entry = entries[from];
  if (!entry || entry.kind !== 'custom') return steps;
  if (afterIndex === from || afterIndex === from - 1 || afterIndex < topSlot(entries)) return steps;
  const rest = entries.filter((_, index) => index !== from);
  const at = afterIndex > from ? afterIndex - 1 : afterIndex;
  return insertAfter(rest, at, entry.step);
}
