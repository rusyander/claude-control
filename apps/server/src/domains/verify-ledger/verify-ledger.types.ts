export type { LedgerEvent, LedgerSummary } from '@agentdeck/contracts';

/** Итог установки preload журнала: `preload: null` — панель ничего не подмешивает. */
export interface LedgerInstall {
  preload: string | null;
  /** Вход с замком для групп разделения (`bin/preload-locked.cjs`); окружение его не снимает. */
  lockedPreload?: string;
  version?: string;
  /** Откуда версия: рабочее дерево или HEAD (дерево журнала грязное — `installLedger` `committedOnly`). */
  source?: 'tree' | 'head';
  reason?: string;
}
