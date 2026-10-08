import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/** Проверочное уведомление на все привязанные телефоны. */
export function useTestRemoteNotification() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async () => {
      const { data } = await apiClient.post<{ ok: boolean; devices: number }>('/remote/test');
      return data;
    },
  });
}
