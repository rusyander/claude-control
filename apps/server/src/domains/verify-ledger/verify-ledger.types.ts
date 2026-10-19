export type { LedgerEvent, LedgerSummary } from '@agentdeck/contracts';

/** Итог установки preload журнала: `preload: null` — панель ничего не подмешивает. */
export interface LedgerInstall {
  preload: string | null;
  version?: string;
  reason?: string;
}
