import type { ActiveRunView } from './selectors';
import { useSyncExternalStore } from 'react';
import { subscribeRuns, getActiveRuns } from './agentRunsStore';

/** Активные прогоны (работают/ждут/упали) — для пульта агентов. */
export function useActiveRuns(): ActiveRunView[] {
  return useSyncExternalStore(subscribeRuns, getActiveRuns, getActiveRuns);
}
