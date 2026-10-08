import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/** Открыть каталог проекта во внешнем редакторе (команда — из настроек). */
export function useOpenInEditor() {
  return useMutation({
    mutationFn: async (path: string) => {
      const { data } = await apiClient.post<{ ok: boolean }>('/projects/open-in-editor', { path });
      return data;
    },
    meta: { successMessage: 'toasts.openingEditor' },
  });
}
