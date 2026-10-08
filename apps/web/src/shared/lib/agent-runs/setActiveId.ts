import { callbacks } from './agent-runs.state';
import { rebalance } from './agent-runs.slots';

/** Какой чат открыт на экране — чтобы не уведомлять о его же завершении. */
export function setActiveId(id: string | undefined): void {
  callbacks.activeId = id;
  // Открытый разговор — первый в очереди за потоком.
  rebalance();
}
