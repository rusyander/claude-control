import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectTestCaseInput,
  ProjectTestRunMode,
  ProjectTestsView,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Тест-кейсы проекта.
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

const ROOT_KEY = 'project-tests';

/** Как часто перечитывать список во время прогона. */
const POLL_MS = 2000;

const key = (path: string | undefined) => [ROOT_KEY, path ?? ''];

export function useProjectTests(path: string | undefined, isOpen: boolean) {
  return useQuery({
    queryKey: key(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestsView>('/project-tests', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isOpen,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.run?.status === 'running' && isOpen ? POLL_MS : false,
  });
}

/** Общая часть мутаций: ответ сервера — это и есть новый список. */
function useViewMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestsView>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => client.setQueryData(key(path), data),
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

export interface StartTestRunPayload {
  mode: ProjectTestRunMode;
  groupId?: string;
  caseIds?: string[];
  scope?: string;
  full?: boolean;
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

export function useStopTestRun(path: string | undefined) {
  return useViewMutation(path, async () => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/stop', { path });
    return data;
  });
}
