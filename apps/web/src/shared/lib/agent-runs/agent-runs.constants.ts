import type { AgentRun } from './agent-runs.types';

export const EMPTY_RUN: AgentRun = {
  id: '',
  status: 'idle',
  text: '',
  thinking: '',
  tools: [],
  tokens: 0,
  askedQuestion: false,
  permissions: [],
  queued: [],
  lastEventAt: 0,
};

/** Сколько раз пробуем переподключиться при обрыве, прежде чем сдаться. */
export const MAX_RECONNECT = 5;

/** Сколько раз сам перезапускаем прогон, упавший по «мигнувшей» причине. */
export const MAX_AUTO_RETRIES = 2;
