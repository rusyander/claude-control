import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PermissionRule, PermissionDraft } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const permissionApi = createEntityApi<PermissionRule, PermissionDraft>({
  resource: 'permissions',
  listKey: queryKeys.permissions,
  kind: 'permission',
});

/**
 * Завести сразу несколько прав одним действием — помощник отбора инструментов
 * MCP заводит по праву на инструмент. Логику записи не дублируем: тот же маршрут
 * `POST /api/permissions`, что и у обычного создания. Пишем по одному по
 * порядку — сервер правит settings.json, параллельные записи в один файл
 * наступали бы друг другу на пятки.
 */
export function useCreatePermissions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (drafts: PermissionDraft[]) => {
      for (const draft of drafts) {
        await apiClient.post('/permissions', draft);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.permissions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.created' },
  });
}

/**
 * Перенести право в противоположный файл настроек: из settings.json в
 * settings.local.json и обратно. Файл-источник сервер определяет по префиксу id.
 */
export function useMovePermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.post(`/permissions/${encodeURIComponent(id)}/move`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.permissions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.moved' },
  });
}
