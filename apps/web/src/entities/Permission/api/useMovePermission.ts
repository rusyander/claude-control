import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

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
