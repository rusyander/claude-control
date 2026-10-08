import type { HandoffEvent, AgentRun } from './agent-runs.types';
import { callbacks } from './agent-runs.state';

/** Колбэк на продолжение в чистой сессии — переезд вкладки и тост. */
export function setOnHandoff(
  callback: ((event: HandoffEvent, run: AgentRun) => void) | undefined,
): void {
  callbacks.onHandoff = callback;
}
