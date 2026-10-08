import type { ProjectRunnerView } from '@agentdeck/contracts';
import { useProjectRuns } from './useProjectRuns';

/** Состояние одной цели или undefined, если она не запускалась. */
export function useProjectRunner(
  path: string | undefined,
  dir = '',
): ProjectRunnerView | undefined {
  return useProjectRuns(path).find((run) => run.dir === dir);
}
