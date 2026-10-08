import { useSyncExternalStore } from 'react';
import { subscribeRuns, getTotalTokens } from './agentRunsStore';

/** Накопленные токены всех прогонов за сессию. */
export function useTotalTokens(): number {
  return useSyncExternalStore(subscribeRuns, getTotalTokens, getTotalTokens);
}
