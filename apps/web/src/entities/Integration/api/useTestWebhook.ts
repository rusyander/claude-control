import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Проверка вебхука — настоящий POST на указанный адрес: «панель настроена»
 * и «приёмник принял» — разные утверждения, и человеку нужно второе.
 */
export function useTestWebhook() {
  return useMutation({
    mutationFn: async (): Promise<{ ok: boolean }> => {
      const { data } = await apiClient.post<{ ok: boolean }>('/integrations/webhook/test', {});
      return data;
    },
    meta: { successMessage: 'integrations.webhook.sent' },
  });
}
