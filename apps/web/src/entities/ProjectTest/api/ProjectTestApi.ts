import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectTestBulkInput,
  ProjectTestCaseInput,
  ProjectTestEnvironment,
  ProjectTestGenerateSource,
  ProjectTestRunMode,
  ProjectTestSchema,
  ProjectTestSharedStep,
  ProjectTestView,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { TESTS_POLL_MS, testKeys } from './keys';

/**
 * Библиотека тестов проекта: группы, кейсы, общие шаги, окружения, схема,
 * сохранённые фильтры.
 *
 * Все правки возвращают уже пересобранный список — сервер отдаёт его тем же
 * ответом. Поэтому мутации не инвалидируют кэш, а КЛАДУТ в него результат: иначе
 * между записью и перезапросом список моргал бы прежним состоянием, а при
 * идущем прогоне ещё и терял бы только что проставленные галочки.
 *
 * Пока прогон идёт, список перечитывается каждые две секунды: статусы пишет сам
 * агент в файлы на диске, и другого источника прогресса здесь нет — это цена
 * того, что кейсы живут в проекте, а не в памяти панели.
 */

export function useProjectTests(path: string | undefined, isOpen: boolean) {
  return useQuery({
    queryKey: testKeys.view(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestsView>('/project-tests', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isOpen,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.run?.status === 'running' && isOpen ? TESTS_POLL_MS : false,
  });
}

/**
 * Общая часть мутаций библиотеки: ответ сервера — это и есть новый список.
 *
 * Соседние ветки кэша (история, отчёт, тест-поинты) считаются по тем же файлам,
 * поэтому после записи они помечаются устаревшими: иначе отчёт показывал бы
 * покрытие до правки, а список поинтов — кейсы, которых уже нет.
 */
function useViewMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestsView>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data);
      void client.invalidateQueries({ queryKey: testKeys.plans(path) });
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
    },
  });
}

export function useCreateTestGroup(path: string | undefined) {
  return useViewMutation(path, async (group: { id: string; title?: string }) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/group', {
      path,
      ...group,
    });
    return data;
  });
}

export function useUpdateTestGroup(path: string | undefined) {
  return useViewMutation(
    path,
    async (group: { id: string; title?: string; description?: string }) => {
      const { data } = await apiClient.post<ProjectTestsView>('/project-tests/group/update', {
        path,
        ...group,
      });
      return data;
    },
  );
}

export function useRemoveTestGroup(path: string | undefined) {
  return useViewMutation(path, async (id: string) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/group', {
      params: { path, id },
    });
    return data;
  });
}

export function useSaveTestCase(path: string | undefined) {
  return useViewMutation(
    path,
    async (payload: { groupId: string; testCase: ProjectTestCaseInput }) => {
      const { data } = await apiClient.post<ProjectTestsView>('/project-tests/case', {
        path,
        ...payload,
      });
      return data;
    },
  );
}

export function useRemoveTestCase(path: string | undefined) {
  return useViewMutation(path, async (payload: { groupId: string; caseId: string }) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/case', {
      params: { path, ...payload },
    });
    return data;
  });
}

/**
 * Массовое действие над отмеченными кейсами. Ответ шире обычного (`touched` —
 * сколько кейсов задето), поэтому мутация своя, а не через `useViewMutation`.
 */
export function useBulkTestCases(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ProjectTestBulkInput) => {
      const { data } = await apiClient.post<{ touched: number; view: ProjectTestsView }>(
        '/project-tests/bulk',
        { path, ...payload },
      );
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
    },
  });
}

export function useSaveSharedStep(path: string | undefined) {
  return useViewMutation(path, async (step: ProjectTestSharedStep) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/shared-step', {
      path,
      step,
    });
    return data;
  });
}

export function useRemoveSharedStep(path: string | undefined) {
  return useViewMutation(path, async (id: string) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/shared-step', {
      params: { path, id },
    });
    return data;
  });
}

export function useSaveTestEnvironment(path: string | undefined) {
  return useViewMutation(path, async (environment: ProjectTestEnvironment) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/environment', {
      path,
      environment,
    });
    return data;
  });
}

/**
 * Убрать окружение. `force` — ответ на отказ сервера «на него ссылается план»:
 * решение «пусть план останется без окружения» принимает человек, и до его
 * нажатия удаления не происходит.
 */
export function useRemoveTestEnvironment(path: string | undefined) {
  return useViewMutation(path, async ({ id, force }: { id: string; force?: boolean }) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/environment', {
      params: { path, id, ...(force ? { force: '1' } : {}) },
    });
    return data;
  });
}

export function useSaveTestSchema(path: string | undefined) {
  return useViewMutation(path, async (schema: ProjectTestSchema) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/schema', {
      path,
      schema,
    });
    return data;
  });
}

export function useSaveTestView(path: string | undefined) {
  return useViewMutation(path, async (view: ProjectTestView) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/view', { path, view });
    return data;
  });
}

export function useRemoveTestView(path: string | undefined) {
  return useViewMutation(path, async (id: string) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/view', {
      params: { path, id },
    });
    return data;
  });
}

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

export function useStopTestRun(path: string | undefined) {
  return useViewMutation(path, async () => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/stop', { path });
    return data;
  });
}

/**
 * Вписать соглашение о кейсах в `CLAUDE.md` проекта: после этого их ведёт и
 * обычный разговор, а не только прогоны из окна тестов.
 */
export function useInstallTestConvention(path: string | undefined) {
  return useViewMutation(path, async () => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/convention', { path });
    return data;
  });
}
