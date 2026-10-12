import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type {
  ApiExplorerInfo,
  ApiHistoryEntry,
  ApiSendResult,
  ApiSpec,
} from '@agentdeck/contracts';
import type { ApiSendBody, ApiSettingsBody } from '@agentdeck/contracts/request-bodies';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Вкладка «API». Источники ищутся по файлам и опросом работающего сервиса —
 * при открытии и по кнопке «Обновить», без опроса по таймеру. Отправка —
 * мутация: у каждого запроса свой ответ, и повторять его сама она не должна
 * (POST дважды — две записи в базе разработчика).
 */

export function useApiExplorerInfo(path: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.apiExplorer.info(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ApiExplorerInfo>('/api-explorer', { params: { path } });
      return data;
    },
    enabled: enabled && Boolean(path),
    retry: false,
  });
}

export function useApiSpec(path: string, sourceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.apiExplorer.spec(path, sourceId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ApiSpec>('/api-explorer/spec', {
        params: { path, sourceId },
      });
      return data;
    },
    enabled: Boolean(sourceId),
    retry: false,
    staleTime: 30_000,
  });
}

/** «Обновить»: заново найти источники и перечитать выбранный контракт мимо кэша сервера. */
export function useRefreshApiExplorer(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (sourceId: string | undefined) => {
      const [info, spec] = await Promise.all([
        apiClient.get<ApiExplorerInfo>('/api-explorer', { params: { path, fresh: '1' } }),
        sourceId
          ? apiClient.get<ApiSpec>('/api-explorer/spec', {
              params: { path, sourceId, fresh: '1' },
            })
          : undefined,
      ]);
      return { info: info.data, spec: spec?.data, sourceId };
    },
    onSuccess: ({ info, spec, sourceId }) => {
      queryClient.setQueryData(queryKeys.apiExplorer.info(path), info);
      if (spec && sourceId)
        queryClient.setQueryData(queryKeys.apiExplorer.spec(path, sourceId), spec);
    },
  });
}

export function useApiHistory(path: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.apiExplorer.history(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ApiHistoryEntry[]>('/api-explorer/history', {
        params: { path },
      });
      return data;
    },
    enabled,
    retry: false,
  });
}

type InfoWithSource = ApiExplorerInfo & { sourceId: string };

export function useAddApiSource(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (url: string) => {
      const { data } = await apiClient.post<InfoWithSource>('/api-explorer/sources', { path, url });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(queryKeys.apiExplorer.info(path), data),
  });
}

export function useImportPostman(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: { name?: string; content: string }) => {
      const { data } = await apiClient.post<InfoWithSource>('/api-explorer/postman', {
        path,
        ...body,
      });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(queryKeys.apiExplorer.info(path), data),
  });
}

export function useRemoveApiSource(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (sourceId: string) => {
      const { data } = await apiClient.post<ApiExplorerInfo>('/api-explorer/sources/remove', {
        path,
        sourceId,
      });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(queryKeys.apiExplorer.info(path), data),
  });
}

export function useApiSettings(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: Omit<ApiSettingsBody, 'path'>) => {
      const { data } = await apiClient.put<ApiExplorerInfo>('/api-explorer/settings', {
        path,
        ...body,
      });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(queryKeys.apiExplorer.info(path), data),
  });
}

export function useApiSend(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: Omit<ApiSendBody, 'path'>) => {
      const { data } = await apiClient.post<ApiSendResult>('/api-explorer/send', {
        path,
        ...body,
      });
      return data;
    },
    // И удачный, и упавший запрос записаны в историю на сервере.
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiExplorer.history(path) }),
  });
}

export function useClearApiHistory(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async () => {
      const { data } = await apiClient.post<ApiHistoryEntry[]>('/api-explorer/history/clear', {
        path,
      });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(queryKeys.apiExplorer.history(path), data),
  });
}
