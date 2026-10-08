import { useSyncExternalStore } from 'react';
import { subscribeRuns, getTotalCost } from './agentRunsStore';

/** Накопленная стоимость всех прогонов за сессию. */
export function useTotalCost(): number {
  return useSyncExternalStore(subscribeRuns, getTotalCost, getTotalCost);
}
