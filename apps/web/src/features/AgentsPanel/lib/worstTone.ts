import type { ActiveRunView } from '@shared/lib/agent-runs';

/** Самый тревожный тон среди активных — для бейджа-счётчика. */
export function worstTone(runs: ActiveRunView[]): 'success' | 'warning' | 'danger' | 'neutral' {
  if (runs.some((run) => run.status === 'error')) return 'danger';
  if (runs.some((run) => run.status === 'waiting')) return 'warning';
  if (runs.some((run) => run.status === 'running')) return 'success';
  // Одни молчащие — серый, как и их точки: живы, но взглянуть стоит.
  return 'neutral';
}
