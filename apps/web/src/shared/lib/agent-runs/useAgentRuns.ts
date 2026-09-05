import { useSyncExternalStore } from 'react';
import type { RunStatus } from './status';
import type { ActiveRunView } from './selectors';
import {
  getAnsweredQuestions,
  getProjectStatuses,
  getChatStatuses,
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

/** Карта «id разговора → статус» — точки в списке чатов одного проекта. */
export function useChatStatuses(): Map<string, RunStatus> {
  return useSyncExternalStore(subscribeRuns, getChatStatuses, getChatStatuses);
}

/** Активные прогоны (работают/ждут/упали) — для пульта агентов. */
export function useActiveRuns(): ActiveRunView[] {
  return useSyncExternalStore(subscribeRuns, getActiveRuns, getActiveRuns);
}

/**
 * Вопросы, на которые уже ответили. Память общая: карточка переживает и уход на
 * другую вкладку, и перезагрузку — иначе тот же вопрос выглядит неотвеченным, а
 * второй ответ стоит ещё одного хода агента.
 */
export function useAnsweredQuestions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeRuns, getAnsweredQuestions, getAnsweredQuestions);
}

/** Накопленная стоимость всех прогонов за сессию. */
export function useTotalCost(): number {
  return useSyncExternalStore(subscribeRuns, getTotalCost, getTotalCost);
}

/** Накопленные токены всех прогонов за сессию. */
export function useTotalTokens(): number {
  return useSyncExternalStore(subscribeRuns, getTotalTokens, getTotalTokens);
}
