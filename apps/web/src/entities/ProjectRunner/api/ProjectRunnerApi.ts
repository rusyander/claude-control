import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PortHoldersInfo,
  ProjectRunnerInfo,
  ProjectRunnerView,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Dev-серверы проектов, запущенные панелью. Список опрашивается коротким
 * поллингом — так статус (поднимается/работает/ошибка) и АДРЕС обновляются сами:
 * порт печатает сам dev-сервер уже после ответа на запуск, поэтому появиться он
 * может только следующим опросом. Старт/стоп/настройки — мутациями.
 *
 * Всё адресуется ЦЕЛЬЮ: корень вкладки (`path`) плюс подпапка (`dir`). У монорепы
 * целей несколько, и работать они могут одновременно.
 */

export const projectRunnerKey = ['project-runner'] as const;

/** Ключ запроса «что здесь можно запустить» — общий для чтения и записи. */
const describeKey = (path: string | undefined) =>
  [...projectRunnerKey, 'describe', path ? normalizeProjectPath(path) : ''] as const;

/** Адрес цели в запросах: корень проекта и подпапка внутри него. */
export interface RunnerTargetRef {
  path: string;
  dir?: string;
}

/** Список запущенных dev-серверов; поллинг ~2с. */
export function useProjectRunners() {
  return useQuery({
    queryKey: projectRunnerKey,
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectRunnerView[]>('/project-runner');
      return data;
    },
    refetchInterval: 2_000,
  });
}

/** Запущенные цели одного проекта — по нормализованному пути его корня. */
export function useProjectRuns(path: string | undefined): ProjectRunnerView[] {
  const runners = useProjectRunners();
  if (!path) return [];
  const key = normalizeProjectPath(path);
  return (runners.data ?? []).filter((run) => normalizeProjectPath(run.projectPath) === key);
}

/** Состояние одной цели или undefined, если она не запускалась. */
export function useProjectRunner(
  path: string | undefined,
  dir = '',
): ProjectRunnerView | undefined {
  return useProjectRuns(path).find((run) => run.dir === dir);
}

/** Что в проекте можно запустить: корень и пакеты монорепозитория. */
export function useProjectRunnerInfo(path: string | undefined) {
  return useQuery({
    queryKey: describeKey(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectRunnerInfo>('/project-runner/describe', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    staleTime: 30_000,
  });
}

/**
 * Общий хук для маршрутов, отвечающих обновлённым описанием целей: ответ кладём
 * прямо в кэш `describe`, чтобы поповер перерисовался без второго запроса.
 */
function useRunnerInfoMutation<TVariables extends { path: string }>(
  url: string,
  body: (variables: TVariables) => Record<string, unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: TVariables) => {
      const { data } = await apiClient.post<ProjectRunnerInfo>(url, body(variables));
      return data;
    },
    onSuccess: (info, { path }) => {
      queryClient.setQueryData(describeKey(path), info);
    },
  });
}

/** Запустить dev-сервер цели (сервер сам откроет браузер, когда узнает адрес). */
export function useStartRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, dir, command }: RunnerTargetRef & { command?: string }) => {
      const { data } = await apiClient.post<ProjectRunnerView>('/project-runner/start', {
        path,
        dir,
        command,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}

/** Остановить dev-сервер цели. */
export function useStopRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, dir }: RunnerTargetRef) => {
      const { data } = await apiClient.post<{ ok: boolean }>('/project-runner/stop', { path, dir });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}

/** Ключ запроса «кто занял порт». */
const portKey = (port: number) => [...projectRunnerKey, 'port', port] as const;

/**
 * Кто занимает порт. Спрашиваем только когда сервер уже пожаловался на
 * занятость: пользователь должен видеть, кого ему предлагают погасить.
 */
export function usePortHolders(port: number | undefined) {
  return useQuery({
    queryKey: portKey(port ?? 0),
    queryFn: async () => {
      const { data } = await apiClient.get<PortHoldersInfo>('/project-runner/port', {
        params: { port },
      });
      return data;
    },
    enabled: Boolean(port),
    staleTime: 5_000,
  });
}

/**
 * Освободить порт — погасить занявшие его процессы. Вызывается только по клику
 * пользователя: панель сама чужие процессы не трогает.
 */
export function useFreePort() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ port }: { port: number }) => {
      const { data } = await apiClient.post<PortHoldersInfo>('/project-runner/free-port', { port });
      return data;
    },
    onSuccess: (info) => {
      queryClient.setQueryData(portKey(info.port), info);
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}

/**
 * Тумблер автозапуска цели: поднимать ли её dev-сервер при старте сервера
 * панели. Ничего не запускает здесь и сейчас — это про следующий старт.
 */
export function useSetRunnerAutostart() {
  return useRunnerInfoMutation<RunnerTargetRef & { enabled: boolean }>(
    '/project-runner/autostart',
    ({ path, dir, enabled }) => ({ path, dir, enabled }),
  );
}

/** Снять автозапуск со всех целей проекта — закрытая вкладка ничего не обещает. */
export function useClearRunnerAutostart() {
  return useRunnerInfoMutation<{ path: string }>('/project-runner/autostart/clear', ({ path }) => ({
    path,
  }));
}

/**
 * Команда запуска и закреплённый порт цели. Пустая строка очищает команду,
 * `null` снимает закрепление порта — иначе снять их было бы нечем.
 */
export function useSaveRunnerSettings() {
  return useRunnerInfoMutation<RunnerTargetRef & { command?: string; port?: number | null }>(
    '/project-runner/settings',
    ({ path, dir, command, port }) => ({ path, dir, command, port }),
  );
}
