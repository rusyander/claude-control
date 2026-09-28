import type { WatcherStatus } from '@agentdeck/contracts';

export interface WatcherSummaryProps {
  status: WatcherStatus;
  /** Сколько наблюдатель работает, мс (`useWatcherElapsed`). */
  elapsed: number;
  /** Единицы расхода из настроек панели. */
  costUnit: 'tokens' | 'money';
  /** Показать путь отчёта (карточка настроек — да, окно индикатора — нет). */
  showReportPath?: boolean;
}
