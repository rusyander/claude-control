import type { ProjectRunnerView } from '@agentdeck/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';
import { useProjectRunners } from './ProjectRunnerApi';

/** Запущенные цели одного проекта — по нормализованному пути его корня. */
export function useProjectRuns(path: string | undefined): ProjectRunnerView[] {
  const runners = useProjectRunners();
  if (!path) return [];
  const key = normalizeProjectPath(path);
  return (runners.data ?? []).filter((run) => normalizeProjectPath(run.projectPath) === key);
}
