import type { ShellView } from './progressView.types';

/** Фон, который кончился не сам и не по воле агента, — его результата не будет. */
export function isLostShell(view: ShellView): boolean {
  return view === 'lost' || view === 'stopped';
}
