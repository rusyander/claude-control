import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EntityKind, WriteResult } from '@claude-control/contracts';
import { apiClient } from './client';
import { queryKeys } from './query-keys';

/**
 * Все сущности управляются одинаково: список, создание, обновление, удаление
 * и переключатель «включено». Вместо шести почти одинаковых модулей —
 * одна фабрика, а сущности остаются тонкими обёртками с точными типами.
 */
export interface EntityApiConfig {
  /** Сегмент пути: /api/<resource>. */
  resource: string;
  /** Ключ кеша списка. */
  listKey: readonly string[];
  /** Тип сущности для маршрута переключения состояния. */
  kind: EntityKind;
  /** Что ещё обновить после записи — обычно сводка на главной. */
  alsoInvalidate?: readonly (readonly string[])[];
}

export function createEntityApi<TItem, TDraft>(config: EntityApiConfig) {
  const { resource, listKey, kind, alsoInvalidate = [queryKeys.overview] } = config;

  async function list(): Promise<TItem[]> {
    const { data } = await apiClient.get<TItem[]>(`/${resource}`);
    return data;
  }

  async function create(draft: TDraft): Promise<WriteResult> {
    const { data } = await apiClient.post<WriteResult>(`/${resource}`, draft);
    return data;
  }

  async function update(input: { id: string; draft: TDraft }): Promise<WriteResult> {
    const { data } = await apiClient.put<WriteResult>(`/${resource}/${input.id}`, input.draft);
    return data;
  }

  async function remove(id: string): Promise<WriteResult> {
    const { data } = await apiClient.delete<WriteResult>(`/${resource}/${id}`);
    return data;
  }

  async function setEnabled(input: { id: string; isEnabled: boolean }): Promise<WriteResult> {
    const { data } = await apiClient.post<WriteResult>(`/entities/${kind}/${input.id}/enabled`, {
      isEnabled: input.isEnabled,
    });
    return data;
  }

  function useList() {
    return useQuery({ queryKey: listKey, queryFn: list });
  }

  /** Общая инвалидация: список сущности плюс всё, что от неё зависит. */
  function useInvalidate() {
    const queryClient = useQueryClient();
    return () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
      for (const key of alsoInvalidate) void queryClient.invalidateQueries({ queryKey: key });
    };
  }

  function useCreate() {
    const invalidate = useInvalidate();
    return useMutation({ mutationFn: create, onSuccess: invalidate });
  }

  function useUpdate() {
    const invalidate = useInvalidate();
    return useMutation({ mutationFn: update, onSuccess: invalidate });
  }

  function useDelete() {
    const invalidate = useInvalidate();
    return useMutation({ mutationFn: remove, onSuccess: invalidate });
  }

  function useSetEnabled() {
    const invalidate = useInvalidate();
    return useMutation({ mutationFn: setEnabled, onSuccess: invalidate });
  }

  return { useList, useCreate, useUpdate, useDelete, useSetEnabled };
}
