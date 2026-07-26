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

/**
 * Путь к одной сущности. id — не всегда слаг: у прав доступа это
 * `deny:Read(~/.ssh/**)`, и сырая подстановка режет его на лишние сегменты
 * пути — Fastify-маршрут `/:id` читает ровно один сегмент и отвечает 404,
 * то есть правило нельзя ни изменить, ни удалить. Кодируем всегда.
 */
export function entityPath(resource: string, id: string): string {
  return `/${resource}/${encodeURIComponent(id)}`;
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
    const { data } = await apiClient.put<WriteResult>(entityPath(resource, input.id), input.draft);
    return data;
  }

  async function remove(id: string): Promise<WriteResult> {
    const { data } = await apiClient.delete<WriteResult>(entityPath(resource, id));
    return data;
  }

  async function setEnabled(input: { id: string; isEnabled: boolean }): Promise<WriteResult> {
    const { data } = await apiClient.post<WriteResult>(
      `/entities/${kind}/${encodeURIComponent(input.id)}/enabled`,
      { isEnabled: input.isEnabled },
    );
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

  // Тосты об успехе — общие для всех сущностей: текст generic («Создано»,
  // «Удалено»), а об ошибке сообщает глобальный MutationCache сам.
  function useCreate() {
    const invalidate = useInvalidate();
    return useMutation({
      mutationFn: create,
      onSuccess: invalidate,
      meta: { successMessage: 'toasts.created' },
    });
  }

  function useUpdate() {
    const invalidate = useInvalidate();
    return useMutation({
      mutationFn: update,
      onSuccess: invalidate,
      meta: { successMessage: 'toasts.saved' },
    });
  }

  function useDelete() {
    const invalidate = useInvalidate();
    return useMutation({
      mutationFn: remove,
      onSuccess: invalidate,
      meta: { successMessage: 'toasts.deleted' },
    });
  }

  function useSetEnabled() {
    const invalidate = useInvalidate();
    return useMutation({
      mutationFn: setEnabled,
      onSuccess: invalidate,
      meta: { successMessage: 'toasts.updated' },
    });
  }

  return { useList, useCreate, useUpdate, useDelete, useSetEnabled };
}
