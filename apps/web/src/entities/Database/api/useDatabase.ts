import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type {
  DbConnectionsInfo,
  DbQueryResult,
  DbSchema,
  MigrationsInfo,
} from '@agentdeck/contracts';
import type {
  DbConnectionBody,
  DbConnectionRemoveBody,
  DbQueryBody,
} from '@agentdeck/contracts/request-bodies';
import { queryKeys } from '@shared/api/query-keys';

/**
 * База проекта. Подключения и миграции читают файлы и docker — опрос не
 * нужен, только при открытии и по кнопке. Схема и запрос соединяются с базой,
 * поэтому ни одна из них не повторяется сама: упавшее соединение — ответ, а не
 * повод стучаться ещё дважды.
 */

export function useDbConnections(path: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.database.connections(path ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<DbConnectionsInfo>('/database/connections', {
        params: { path },
      });
      return data;
    },
    enabled: enabled && Boolean(path),
    retry: false,
  });
}

export function useDbSchema(path: string, connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.database.schema(path, connectionId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<DbSchema>('/database/schema', {
        params: { path, connectionId },
      });
      return data;
    },
    enabled: Boolean(connectionId),
    retry: false,
    staleTime: 60_000,
  });
}

export function useDbMigrations(path: string, connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.database.migrations(path, connectionId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<MigrationsInfo>('/database/migrations', {
        params: { path, ...(connectionId ? { connectionId } : {}) },
      });
      return data;
    },
    retry: false,
    staleTime: 30_000,
  });
}

/** Запрос — мутация: у каждого прогона свой ответ, кэшировать его по тексту незачем. */
export function useDbQuery() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: DbQueryBody) => {
      const { data } = await apiClient.post<DbQueryResult>('/database/query', body);
      return data;
    },
  });
}

export function useSaveDbConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: DbConnectionBody) => {
      const { data } = await apiClient.post<DbConnectionsInfo & { savedId: string }>(
        '/database/connections',
        body,
      );
      return data;
    },
    onSuccess: (data, body) => {
      queryClient.setQueryData(queryKeys.database.connections(body.path), data);
      // Реквизиты могли смениться — старая схема этого id больше не правда.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.database.schema(body.path, data.savedId),
      });
    },
  });
}

export function useRemoveDbConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: DbConnectionRemoveBody) => {
      const { data } = await apiClient.post<DbConnectionsInfo>(
        '/database/connections/remove',
        body,
      );
      return data;
    },
    onSuccess: (data, body) => {
      queryClient.setQueryData(queryKeys.database.connections(body.path), data);
    },
  });
}

/** Переходник MCP для агента: записать в конфигурацию CLI или убрать. */
export function useDbMcp(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (enabled: boolean) => {
      const { data } = await apiClient.post<{ connected: boolean }>('/database/mcp', { enabled });
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData<DbConnectionsInfo>(queryKeys.database.connections(path), (old) =>
        old ? { ...old, mcpRegistered: data.connected } : old,
      );
    },
  });
}
