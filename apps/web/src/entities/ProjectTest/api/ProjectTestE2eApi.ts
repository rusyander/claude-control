import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectTestE2eSync,
  ProjectTestPyramid,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Папка e2e проекта: завести, убрать, сверить с кейсами.
 *
 * Состояние папки едет в общем виде раздела (`view.e2e`), поэтому отдельного
 * запроса на чтение здесь нет: каждый ответ-правка возвращает вид целиком, и
 * карточка папки со списком групп обновляются одним кадром.
 */

function useViewMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestsView>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (view) => {
      client.setQueryData(testKeys.view(path), view);
    },
  });
}

/** Завести папку `e2e/` (скрытую от git); своя папка проекта остаётся как есть. */
export function useCreateE2eFolder(path: string | undefined) {
  return useViewMutation(path, async (_: void) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/e2e', { path });
    return data;
  });
}

/** Убрать заведённую панелью папку; `force` — вместе с чужими файлами в ней. */
export function useRemoveE2eFolder(path: string | undefined) {
  return useViewMutation(path, async (payload: { force?: boolean }) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/e2e', {
      params: { path, ...(payload.force ? { force: '1' } : {}) },
    });
    return data;
  });
}

/**
 * Сверить тесты папки с кейсами: ответ — итог сверки и новый вид. `dir` —
 * человек выбрал другую из найденных папок (монорепозиторий): сервер запомнит
 * выбор, и дальше раздел идёт по ней.
 */
export function useSyncE2eFolder(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input?: { dir?: string }) => {
      const { data } = await apiClient.post<{ sync: ProjectTestE2eSync; view: ProjectTestsView }>(
        '/project-tests/e2e/sync',
        { path, ...(input?.dir ? { dir: input.dir } : {}) },
      );
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
      void client.invalidateQueries({ queryKey: testKeys.lint(path) });
    },
  });
}

/**
 * «Прогнать автотесты»: панель сама запускает команду каркаса, без агента и без
 * токенов. Ход едет в виде раздела (`view.e2eRun`), вид перечитывается, пока
 * прогон идёт (`useProjectTests`).
 */
export function useRunE2eTests(path: string | undefined) {
  return useViewMutation(path, async (payload: { environmentId?: string; groupId?: string }) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/e2e/run', {
      path,
      environmentId: payload.environmentId,
      groupId: payload.groupId,
    });
    return data;
  });
}

/** Остановить прогон автотестов: итог — то, что успело лечь в отчёт. */
export function useStopE2eTests(path: string | undefined) {
  return useViewMutation(path, async (_: void) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/e2e/run/stop', {
      path,
    });
    return data;
  });
}

/**
 * Прогон кончился — история, отчёт и история кейсов считаются по тем же файлам
 * и устарели: без сброса новая строка истории появилась бы только после F5.
 * Отметки «нестабилен» — тоже: их подпись следит только за прогоном агента.
 */
export function useE2eRunSettled(path: string | undefined, finishedAt: string | undefined) {
  const client = useQueryClient();
  useEffect(() => {
    if (!finishedAt) return;
    for (const key of [
      testKeys.runs(path),
      testKeys.report(path),
      testKeys.caseHistory(path),
      testKeys.flaky(path),
    ]) {
      void client.invalidateQueries({ queryKey: key });
    }
  }, [client, path, finishedAt]);
}

/**
 * Пирамида тестов: модульные и интеграционные рядом с e2e. Сервер обходит весь
 * проект, поэтому запрос не опрашивается: он перечитывается, когда наблюдатель
 * папки или правка раздела сбрасывают ключи `project-tests`, и по кнопке.
 */
export function useTestPyramid(path: string | undefined) {
  return useQuery({
    queryKey: testKeys.pyramid(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestPyramid>('/project-tests/pyramid', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    staleTime: 5 * 60_000,
  });
}
