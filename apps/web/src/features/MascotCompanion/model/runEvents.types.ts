import type { ActiveRunView } from '@shared/lib/agent-runs';

export type RunSnapshot = Map<
  string,
  Pick<ActiveRunView, 'status' | 'sessionId' | 'projectPath' | 'startedAt' | 'limitHit'>
>;

export interface RunEvent {
  kind: 'ask' | 'error' | 'done' | 'limit';
  id: string;
  sessionId?: string;
  projectPath?: string;
  /** `done` хода, шедшего дольше `LONG_RUN_MS`. */
  long?: true;
}
