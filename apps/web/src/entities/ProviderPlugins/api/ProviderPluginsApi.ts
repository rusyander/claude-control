import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderPluginFileContent,
  ProviderPluginFileDraft,
  ProviderPluginsInfo,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Плагины активного провайдера (OpenCode, OPENCODE-4).
 *
 * Это НЕ раздел «Плагины» самой панели (`entities/Plugin`, `/api/plugins`) — тот
 * не тронут. Здесь плагины чужого CLI: каталог файлов JS/TS (список, чтение,
 * создание/обновление, удаление) и отдельно список npm-пакетов `plugin` в
 * `opencode.json`.
 *
 * Проектный уровень — те же данные по другому адресу.
 */

interface Scope {
  /** Задан → каталог и конфиг проекта, иначе глобальные. */
  projectId?: string;
}

function basePath(projectId?: string): string {
  return projectId ? `/projects/${projectId}/provider/plugins` : '/provider-plugins';
}

function infoKey(projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderPlugins(projectId) : queryKeys.providerPlugins;
}

function fileKey(path: string, projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderPluginFile(projectId, path)
    : queryKeys.providerPluginFile(path);
}

/** Файлы каталога + список npm-пакетов. Половины независимы (у каждой свой readOnly). */
export function useProviderPlugins({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: infoKey(projectId),
    queryFn: async (): Promise<ProviderPluginsInfo> => {
      const { data } = await apiClient.get<ProviderPluginsInfo>(basePath(projectId));
      return data;
    },
  });
}

/** Содержимое одного файла плагина — как есть, панель его ничем не разбирает. */
export function useProviderPluginFile(path: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: fileKey(path ?? '', projectId),
    enabled: Boolean(path),
    queryFn: async (): Promise<ProviderPluginFileContent> => {
      const { data } = await apiClient.get<ProviderPluginFileContent>(
        `${basePath(projectId)}/file`,
        { params: { path } },
      );
      return data;
    },
  });
}

/** Создание и обновление — один и тот же PUT: путь файла и есть его идентичность. */
export function useSaveProviderPluginFile({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderPluginFileDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/file`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: fileKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

/** Удаление файла: на сервере перед удалением делается резервная копия. */
export function useDeleteProviderPluginFile({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string): Promise<WriteResult> => {
      const { data } = await apiClient.delete<WriteResult>(`${basePath(projectId)}/file`, {
        params: { path },
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}

/** Список npm-плагинов целиком: пустой список удаляет ключ `plugin` из конфига. */
export function useSaveProviderPluginPackages({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (packages: string[]): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/packages`, {
        packages,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
