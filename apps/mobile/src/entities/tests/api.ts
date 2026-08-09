import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ProjectTestCaseInput,
  ProjectTestRunMode,
  ProjectTestsView,
} from '@claude-control/contracts';
import { api } from '../../shared/api/client';

/**
 * Тест-кейсы проекта — те же файлы в `.agent/tests/`, что видит панель.
 *
 * Прогон запускается на КОМПЬЮТЕРЕ: агент поднимает приложение и ходит по нему
 * там же, где лежит код. Телефон — пульт и экран результата, не исполнитель;
 * иначе пришлось бы объяснять, что значит «прогнать GUI» на устройстве, где
 * этого интерфейса нет.
 *
 * Пока прогон идёт, список перечитывается раз в две секунды: статусы пишет сам
 * агент в файлы, другого источника прогресса нет.
 */

const KEY = 'project-tests';
const POLL_MS = 2000;

export function useProjectTests(projectPath: string | undefined): UseQueryResult<ProjectTestsView> {
  return useQuery({
    queryKey: [KEY, projectPath],
    queryFn: () => api.get<ProjectTestsView>('/project-tests', { path: projectPath }),
    enabled: Boolean(projectPath),
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.run?.status === 'running' ? POLL_MS : false),
  });
}

/**
 * Общая часть правок: сервер отвечает уже пересобранным списком, и мы кладём
 * его в кэш вместо инвалидации — иначе между записью и перезапросом экран
 * моргал бы прежним состоянием, а во время прогона терял бы свежие галочки.
 */
function useViewMutation<TVariables>(
  projectPath: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestsView>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => client.setQueryData([KEY, projectPath], data),
  });
}

export interface StartTestRun {
  mode: ProjectTestRunMode;
  groupId?: string;
  caseIds?: string[];
  scope?: string;
  full?: boolean;
}

export function useStartTestRun(projectPath: string | undefined) {
  return useViewMutation(projectPath, (payload: StartTestRun) =>
    api.post<ProjectTestsView>('/project-tests/run', { path: projectPath, ...payload }),
  );
}

export function useStopTestRun(projectPath: string | undefined) {
  return useViewMutation(projectPath, () =>
    api.post<ProjectTestsView>('/project-tests/stop', { path: projectPath }),
  );
}

/**
 * Вписать соглашение о кейсах в `CLAUDE.md` проекта: после этого их ведёт и
 * обычный разговор, а не только прогоны, запущенные отсюда.
 */
export function useInstallTestConvention(projectPath: string | undefined) {
  return useViewMutation(projectPath, () =>
    api.post<ProjectTestsView>('/project-tests/convention', { path: projectPath }),
  );
}

export function useSaveTestCase(projectPath: string | undefined) {
  return useViewMutation(
    projectPath,
    (payload: { groupId: string; testCase: ProjectTestCaseInput }) =>
      api.post<ProjectTestsView>('/project-tests/case', { path: projectPath, ...payload }),
  );
}

export function useRemoveTestCase(projectPath: string | undefined) {
  return useViewMutation(projectPath, (payload: { groupId: string; caseId: string }) =>
    api.deleteBy<ProjectTestsView>('/project-tests/case', { path: projectPath, ...payload }),
  );
}
