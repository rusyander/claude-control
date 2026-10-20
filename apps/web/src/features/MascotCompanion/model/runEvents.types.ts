import type { ActiveRunView } from '@shared/lib/agent-runs';

export type RunSnapshot = Map<string, Pick<ActiveRunView, 'status' | 'sessionId' | 'projectPath'>>;

export interface RunEvent {
  kind: 'ask' | 'error' | 'done';
  id: string;
  sessionId?: string;
  projectPath?: string;
}
