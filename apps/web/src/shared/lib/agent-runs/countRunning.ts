import type { RunLike } from './selectors.types';
import { runStatus } from './status';
import { isLive } from './isLive';

/**
 * Сколько активных прогонов сейчас работает (для бейджа-счётчика). Молчащий —
 * тоже работает: процесс жив, просто событий давно не было.
 */
export function countRunning(runs: RunLike[], now: number): number {
  return runs.filter((run) =>
    isLive(
      runStatus({
        status: run.status,
        lastEventAt: run.lastEventAt,
        now,
        pendingPermission: (run.permissions?.length ?? 0) > 0,
      }),
    ),
  ).length;
}
