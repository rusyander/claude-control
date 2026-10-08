import type { EnvTransferPlanEntry } from '../EnvTransfer.types';

/** Что отмечено при открытии плана: только новое. */
export function defaultSelection(entries: EnvTransferPlanEntry[]): string[] {
  return entries.filter((entry) => entry.status === 'new').map((entry) => entry.archivePath);
}
