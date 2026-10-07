import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LocalClaudeInfo,
  LocalConnectInfo,
  LocalDevice,
  LocalJob,
  LocalModelsInfo,
  LocalServerInfo,
  ModelBench,
} from '@agentdeck/contracts/local-models';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getLocalModels(): Promise<LocalModelsInfo> {
  const { data } = await apiClient.get<LocalModelsInfo>('/local-models');
  return data;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const { data } = await apiClient.post<T>(path, body ?? {});
  return data;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const { data } = await apiClient.put<T>(path, body);
  return data;
}

/**
 * Пока идёт загрузка, страница опрашивает раз в секунду — полоса и скорость
 * должны двигаться. Без загрузок — раз в десять секунд: загруженная в память
 * модель выгружается сама по простою, и строка «в памяти» не должна врать.
 */
const BUSY_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 10_000;

export function hasRunningJob(info: LocalModelsInfo | undefined): boolean {
  return Boolean(info?.jobs.some((job) => job.state === 'running'));
}

export function useLocalModels(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.localModels,
    queryFn: getLocalModels,
    enabled: options.enabled ?? true,
    refetchInterval: (query) =>
      hasRunningJob(query.state.data) ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
  });
}

/** Любое действие раздела меняет общий снимок — после него снимок перечитывается. */
function useLocalAction<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.localModels }),
  });
}

/** Перемерить железо: свободная видеопамять меняется, пока человек работает. */
export const useRefreshHardware = () =>
  useLocalAction<void, unknown>(() => post('/local-models/hardware/refresh'));

export const useInstallRuntime = () =>
  useLocalAction<void, LocalJob>(() => post('/local-models/runtime/install'));

export const useStartLocalServer = () =>
  useLocalAction<string | undefined, LocalServerInfo>((tag) =>
    post('/local-models/server/start', tag ? { tag } : {}),
  );

export const useStopLocalServer = () =>
  useLocalAction<void, { unloaded: string[] }>(() => post('/local-models/server/stop'));

/** Скачать модель; `connect` — по готовности сразу включить её агентам. */
export const usePullModel = () =>
  useLocalAction<{ tag: string; connect?: boolean }, LocalJob>((input) =>
    post('/local-models/pull', input),
  );

export const useImportModel = () =>
  useLocalAction<string, LocalJob>((tag) => post('/local-models/import', { tag }));

export const useRemoveModel = () =>
  useLocalAction<string, void>(async (tag) => {
    await apiClient.delete(`/local-models/models/${encodeURIComponent(tag)}`);
  });

export const useBenchModel = () =>
  useLocalAction<string, ModelBench>((tag) => post('/local-models/bench', { tag }));

export const useConnectLocal = () =>
  useLocalAction<string, LocalConnectInfo>((tag) => post('/local-models/connect', { tag }));

export const useDisconnectLocal = () =>
  useLocalAction<void, LocalConnectInfo>(() => post('/local-models/disconnect'));

/** Где считать: идущий сервер перезапускается с новым устройством сразу. */
export const useSetLocalDevice = () =>
  useLocalAction<LocalDevice, LocalServerInfo>((device) => put('/local-models/device', { device }));

/** «Claude Code на локальной модели»: settings.json Claude, выключение возвращает прежнее. */
export const useSetLocalClaude = () =>
  useLocalAction<{ on: boolean; tag?: string }, LocalClaudeInfo>((body) =>
    put('/local-models/claude', body),
  );

export const useInstallQwenCode = () =>
  useLocalAction<void, LocalJob>(() => post('/local-models/qwen-code/install'));

export const useCancelLocalJob = () =>
  useLocalAction<string, void>(async (id) => {
    await apiClient.post(`/local-models/jobs/${encodeURIComponent(id)}/cancel`);
  });
