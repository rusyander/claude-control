import type { RunStatus } from './status.types';

/** Прогон жив: работает, пусть даже молча. */
export function isLive(status: RunStatus): boolean {
  return status === 'running' || status === 'quiet';
}
