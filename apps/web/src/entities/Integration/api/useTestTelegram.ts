import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Проверка Telegram отдельным маршрутом: она не «дозвонилась ли панель до
 * Bot API», а «пришло ли сообщение в тот чат» — а это видно только в чате.
 */
export function useTestTelegram() {
  return useMutation({
    mutationFn: async (): Promise<{ ok: boolean }> => {
      const { data } = await apiClient.post<{ ok: boolean }>('/integrations/telegram/test', {});
      return data;
    },
    meta: { successMessage: 'integrations.telegram.sent' },
  });
}
