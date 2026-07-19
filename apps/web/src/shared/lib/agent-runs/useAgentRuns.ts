import { useSyncExternalStore } from 'react';
import type { RunStatus } from './status';
import type { ActiveRunView } from './selectors';
import {
  getProjectStatuses,
  getActiveRuns,
  getTotalCost,
  getTotalTokens,
  getRun,
  subscribeRuns,
  type AgentRun,
} from './agentRunsStore';

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

/** Активные прогоны (работают/ждут/упали) — для пульта агентов. */
export function useActiveRuns(): ActiveRunView[] {
  return useSyncExternalStore(subscribeRuns, getActiveRuns, getActiveRuns);
}

/** Накопленная стоимость всех прогонов за сессию. */
export function useTotalCost(): number {
  return useSyncExternalStore(subscribeRuns, getTotalCost, getTotalCost);
}

/** Накопленные токены всех прогонов за сессию. */
export function useTotalTokens(): number {
  return useSyncExternalStore(subscribeRuns, getTotalTokens, getTotalTokens);
}
