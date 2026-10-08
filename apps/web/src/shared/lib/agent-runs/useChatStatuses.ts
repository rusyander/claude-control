import type { RunStatus } from './status.types';
import { useSyncExternalStore } from 'react';
import { subscribeRuns, getChatStatuses } from './agentRunsStore';

/** Карта «id разговора → статус» — точки в списке чатов одного проекта. */
export function useChatStatuses(): Map<string, RunStatus> {
  return useSyncExternalStore(subscribeRuns, getChatStatuses, getChatStatuses);
}
