import { useSyncExternalStore } from 'react';
import type { RunStatus } from './status';
import { getProjectStatuses, getRun, subscribeRuns, type AgentRun } from './agentRunsStore';

/** Состояние конкретного прогона (активного чата). */
export function useAgentRun(id: string | undefined): AgentRun {
  return useSyncExternalStore(
    subscribeRuns,
    () => getRun(id),
    () => getRun(id),
  );
}

/** Карта «нормализованный путь проекта → статус» для точек на табах и в списке. */
export function useProjectStatuses(): Map<string, RunStatus> {
  return useSyncExternalStore(subscribeRuns, getProjectStatuses, getProjectStatuses);
}
