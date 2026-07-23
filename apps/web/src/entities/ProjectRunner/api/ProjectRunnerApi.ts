import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectRunnerInfo, ProjectRunnerView } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Dev-серверы проектов, запущенные панелью. Список опрашивается коротким
 * поллингом — так статус на кнопке (поднимается/работает/ошибка) обновляется
 * сам, пока сервер стартует и пока работает. Старт/стоп — мутациями.
 */

export const projectRunnerKey = ['project-runner'] as const;

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

/**
 * Состояние dev-сервера конкретного проекта из общего списка — по
 * нормализованному пути (сервер отдаёт абсолютный путь без учёта регистра/слэшей).
 */
export function useProjectRunner(path: string | undefined): ProjectRunnerView | undefined {
  const runners = useProjectRunners();
  if (!path) return undefined;
  const key = normalizeProjectPath(path);
  return runners.data?.find((runner) => normalizeProjectPath(runner.path) === key);
}

/** Можно ли запустить проект и какой командой — для подсказки/дизейбла кнопки. */
export function useProjectRunnerInfo(path: string | undefined) {
  return useQuery({
    queryKey: [...projectRunnerKey, 'describe', path ? normalizeProjectPath(path) : ''],
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

/** Запустить dev-сервер проекта (сервер сам откроет браузер при готовности). */
export function useStartRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => {
      const { data } = await apiClient.post<ProjectRunnerView>('/project-runner/start', { path });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}

/** Остановить dev-сервер проекта. */
export function useStopRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => {
      const { data } = await apiClient.post<{ ok: boolean }>('/project-runner/stop', { path });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectRunnerKey });
    },
  });
}
