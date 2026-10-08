import type { RunStatus } from './status.types';

/** Насколько статус «важен» для показа: у проекта берём самый тревожный. */
export const SEVERITY: Record<RunStatus, number> = {
  idle: 0,
  quiet: 1,
  // Работающий заметнее молчащего: пока в проекте кто-то работает, таб
  // зелёный — молчащего видно по его собственной точке в списке разговоров.
  running: 2,
  waiting: 3,
  error: 4,
};

/** Итоговый статус проекта — самый тревожный среди его прогонов. */
export function aggregateStatus(statuses: RunStatus[]): RunStatus {
  return statuses.reduce<RunStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    'idle',
  );
}
