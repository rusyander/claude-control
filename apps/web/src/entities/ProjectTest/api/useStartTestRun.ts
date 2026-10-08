import type {
  ProjectTestRunMode,
  ProjectTestGenerateSource,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';

export interface StartTestRunPayload {
  mode: ProjectTestRunMode;
  groupId?: string;
  caseIds?: string[];
  planId?: string;
  environmentId?: string;
  scope?: string;
  /** Веха прогона; пусто — сервер возьмёт ближайший тег git. */
  release?: string;
  full?: boolean;
  changedOnly?: boolean;
  /** Принимать черновик генерации без просмотра. Сервер помнит это на проект. */
  autoAccept?: boolean;
  /** Откуда генерация берёт материал; пусто — по коду проекта. */
  source?: ProjectTestGenerateSource;
  /** Требование или дефект: ключ задачи либо ссылка. */
  sourceRef?: string;
  /** Диапазон сравнения для источника «дифф»; пусто — `origin/main..HEAD`. */
  diffRange?: string;
  /** Провал, из которого заводится регрессионный кейс. */
  sourceCase?: { groupId: string; caseId: string; runId?: string };
  /** Генерация пишет ещё и спеки в папку e2e и прогоняет их. */
  e2e?: boolean;
}

export function useStartTestRun(path: string | undefined) {
  return useViewMutation(path, async (payload: StartTestRunPayload) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/run', {
      path,
      ...payload,
    });
    return data;
  });
}
