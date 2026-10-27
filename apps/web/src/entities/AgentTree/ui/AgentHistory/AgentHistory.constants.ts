import type { AgentState } from '../../model/agentTree.types';

/** Тон точки субагента в истории — тот же, что у переходов карточки группы. */
export const STATE_TONE: Record<AgentState, 'danger' | 'success' | 'warning' | 'neutral'> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  lost: 'danger',
  stopped: 'neutral',
};
