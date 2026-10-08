import { callbacks } from './agent-runs.state';

/** Колбэк по завершении любого прогона — страница обновляет список чатов. */
export function setOnFinished(callback: (() => void) | undefined): void {
  callbacks.onFinished = callback;
}
