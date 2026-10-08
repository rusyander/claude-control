import { useSyncExternalStore } from 'react';
import { getRun, subscribeRuns, type AgentRun } from './agentRunsStore';

/** Состояние конкретного прогона (активного чата). */
export function useAgentRun(id: string | undefined): AgentRun {
  return useSyncExternalStore(
    subscribeRuns,
    () => getRun(id),
    () => getRun(id),
  );
}
