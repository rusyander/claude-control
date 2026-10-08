import type { RunStatus } from './status.types';
import { useSyncExternalStore } from 'react';
import { subscribeRuns, getProjectStatuses } from './agentRunsStore';

/** Карта «нормализованный путь проекта → статус» для точек на табах и в списке. */
export function useProjectStatuses(): Map<string, RunStatus> {
  return useSyncExternalStore(subscribeRuns, getProjectStatuses, getProjectStatuses);
}
