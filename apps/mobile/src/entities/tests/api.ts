import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ProjectTestCaseInput,
  ProjectTestManualResultInput,
  ProjectTestManualSession,
  ProjectTestRunMode,
  ProjectTestRunRecord,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Тест-кейсы проекта — те же файлы в `.agent/tests/`, что видит панель.
 *
 * Прогон АГЕНТА запускается на КОМПЬЮТЕРЕ: он поднимает приложение и ходит по
 * нему там же, где лежит код. Телефон — пульт и экран результата, не исполнитель;
 * иначе пришлось бы объяснять, что значит «прогнать GUI» на устройстве, где
 * этого интерфейса нет.
 *
 * Ручной прогон — исключение и главная причина, по которой этот экран вообще
 * нужен в руке: проверяет человек, глядя на настоящее приложение (часто на
 * этом же телефоне), а панель только записывает результат. Поэтому сессия
 * ручного прогона живёт на СЕРВЕРЕ, а не в памяти экрана: её начинают в панели
 * и дописывают с телефона, и наоборот.
 *
 * Пока прогон идёт, список перечитывается раз в две секунды: статусы пишет сам
 * агент в файлы, другого источника прогресса нет.
 */

const KEY = 'project-tests';
const RUNS_KEY = 'project-tests-runs';
const MANUAL_KEY = 'project-tests-manual';
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
  planId?: string;
  environmentId?: string;
  scope?: string;
  full?: boolean;
  changedOnly?: boolean;
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

/** История прогонов: список записей `runs/*.run.json` от новых к старым. */
export function useTestRuns(
  projectPath: string | undefined,
  limit = 50,
): UseQueryResult<ProjectTestRunRecord[]> {
  return useQuery({
    queryKey: [RUNS_KEY, projectPath, limit],
    queryFn: async () => {
      const body = await api.get<{ runs: ProjectTestRunRecord[] }>('/project-tests/runs', {
        path: projectPath,
        limit,
      });
      return body.runs;
    },
    enabled: Boolean(projectPath),
  });
}

/**
 * Открытая сессия ручного прогона. `undefined` — её нет, и это НЕ ошибка:
 * экран показывает кнопку «начать», а не пустое место с крутилкой.
 */
export function useManualSession(
  projectPath: string | undefined,
): UseQueryResult<ProjectTestManualSession | undefined> {
  return useQuery({
    queryKey: [MANUAL_KEY, projectPath],
    queryFn: async () => {
      const body = await api.get<{ session?: ProjectTestManualSession }>('/project-tests/manual', {
        path: projectPath,
      });
      return body.session;
    },
    enabled: Boolean(projectPath),
    staleTime: 0,
  });
}

/**
 * Общая часть ручного прогона: сервер отвечает сессией, и она кладётся в кэш
 * той же ключом, что читает экран, — отметка результата должна проступать
 * сразу, без перезапроса, иначе на медленной сети человек жмёт статус дважды.
 *
 * Список кейсов после отметки тоже устаревает — статус кейса пишется в файл
 * группы, — поэтому он помечается на перезапрос, а не переписывается вслепую.
 */
function useManualMutation<TVariables>(
  projectPath: string | undefined,
  send: (variables: TVariables) => Promise<{ session?: ProjectTestManualSession }>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      client.setQueryData([MANUAL_KEY, projectPath], data.session);
      void client.invalidateQueries({ queryKey: [KEY, projectPath] });
    },
  });
}

export interface StartManualRun {
  planId?: string;
  groupId?: string;
  caseIds?: string[];
  environmentId?: string;
}

export function useStartManualRun(projectPath: string | undefined) {
  return useManualMutation(projectPath, (payload: StartManualRun) =>
    api.post<{ session: ProjectTestManualSession }>('/project-tests/manual/start', {
      path: projectPath,
      ...payload,
    }),
  );
}

export function useSaveManualResult(projectPath: string | undefined) {
  return useManualMutation(projectPath, (payload: ProjectTestManualResultInput) =>
    api.post<{ session: ProjectTestManualSession }>('/project-tests/manual/result', {
      path: projectPath,
      ...payload,
    }),
  );
}

/**
 * Закрыть ручной прогон. `finish` записывает его в историю, `cancel` бросает:
 * разные кнопки, потому что «я закончил» и «я передумал» дают разный след в
 * `runs/` — и путать их значит врать отчёту.
 */
export function useCloseManualRun(projectPath: string | undefined) {
  const client = useQueryClient();
  return useManualMutation(projectPath, async (payload: { runId: string; cancel?: boolean }) => {
    const body = await api.post<{ session?: ProjectTestManualSession }>(
      payload.cancel ? '/project-tests/manual/cancel' : '/project-tests/manual/finish',
      { path: projectPath, runId: payload.runId },
    );
    await client.invalidateQueries({ queryKey: [RUNS_KEY, projectPath] });
    return body;
  });
}
