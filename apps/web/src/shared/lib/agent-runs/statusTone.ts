import type { RunStatus } from './status.types';

/** Тон точки для дизайн-системы. idle → точки нет. */
export function statusTone(
  status: RunStatus,
): 'success' | 'neutral' | 'warning' | 'danger' | undefined {
  switch (status) {
    case 'running':
      return 'success';
    case 'quiet':
      return 'neutral';
    case 'waiting':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return undefined;
  }
}
