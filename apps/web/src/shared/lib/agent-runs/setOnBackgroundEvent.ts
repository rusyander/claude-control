import type { AgentRun } from './agent-runs.types';
import { callbacks } from './agent-runs.state';

/** Колбэк по завершении ФОНОВОГО проектного прогона — для тоста-уведомления. */
export function setOnBackgroundEvent(callback: ((run: AgentRun) => void) | undefined): void {
  callbacks.onBackgroundEvent = callback;
}
