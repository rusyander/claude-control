import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IntegrationStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { integrationKeys } from './keys';
import { CHECK_TIMEOUT_MS } from './useCheckIntegration';

/**
 * Перенос выбранных находок и сразу живая проверка каждой.
 *
 * Перенос — одна запись на сервере: две находки на одну интеграцию или
 * неполная находка отклоняются целиком, до первой записи. Проверка идёт уже
 * после — её отказ не отменяет перенос, а виден в карточке, как после «Проверить
 * связь»: адрес и ключ взяты из рабочего MCP-сервера, но работает ли он с панели,
 * знает только живой запрос.
 */
export function useApplyDiscovered() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (keys: string[]): Promise<IntegrationStatus[]> => {
      const { data } = await apiClient.post<IntegrationStatus[]>('/integrations/discover', {
        keys,
      });
      const checked = await Promise.allSettled(
        data.map((status) =>
          apiClient.post<IntegrationStatus>(
            `/integrations/${encodeURIComponent(status.id)}/check`,
            {},
            { timeout: CHECK_TIMEOUT_MS },
          ),
        ),
      );
      return data.map((status, index) => {
        const result = checked[index];
        return result?.status === 'fulfilled' ? result.value.data : status;
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: integrationKeys.root });
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
    meta: { successMessage: 'integrations.discover.applied' },
  });
}
