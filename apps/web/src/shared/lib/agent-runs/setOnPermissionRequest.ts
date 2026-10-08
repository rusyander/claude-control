import type { AgentRun } from './agent-runs.types';
import { callbacks } from './agent-runs.state';

/** Колбэк на новый запрос прав любого прогона — звук/тост/карточка. */
export function setOnPermissionRequest(callback: ((run: AgentRun) => void) | undefined): void {
  callbacks.onPermissionRequest = callback;
}
