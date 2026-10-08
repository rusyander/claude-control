import type { EnvTransferPlanEntry } from '../EnvTransfer.types';
import { selectableEntries } from './EnvTransferPlan';

/** Отмечено ли всё, что можно отметить (для переключателя «отметить всё»). */
export function isAllSelected(entries: EnvTransferPlanEntry[], selected: Set<string>): boolean {
  const selectable = selectableEntries(entries);
  return selectable.length > 0 && selectable.every((entry) => selected.has(entry.archivePath));
}
