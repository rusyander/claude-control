import type { WatcherStatus } from '@agentdeck/contracts';

export interface WatcherSummaryProps {
  status: WatcherStatus;
  /** Сколько наблюдатель работает, мс (`useWatcherElapsed`). */
  elapsed: number;
  /** Единицы расхода из настроек панели. */
  costUnit: 'tokens' | 'money';
}
