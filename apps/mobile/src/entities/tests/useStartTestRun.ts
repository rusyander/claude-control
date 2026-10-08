import type { ProjectTestRunMode, ProjectTestsView } from '@agentdeck/contracts';
import { useViewMutation } from './useViewMutation';
import { api } from '../../shared/api/client';

export interface StartTestRun {
  mode: ProjectTestRunMode;
  groupId?: string;
  caseIds?: string[];
  planId?: string;
  environmentId?: string;
  scope?: string;
  /** Веха прогона; пусто — сервер снимет её с ближайшего тега git. */
  release?: string;
  full?: boolean;
  changedOnly?: boolean;
}

export function useStartTestRun(projectPath: string | undefined) {
  return useViewMutation(projectPath, (payload: StartTestRun) =>
    api.post<ProjectTestsView>('/project-tests/run', { path: projectPath, ...payload }),
  );
}
