import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderEnvInfo, ProviderEnvVar, WriteResult } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Универсальные переменные окружения активного провайдера (Codex). Отдельный от
 * Claude набор запросов: Claude env живёт на богатых роутах `/api/env` со своей
 * страницей (источники, маски, перенос) — клиент выбирает набор по активному
 * провайдеру. GET возвращает не просто список, а `ProviderEnvInfo` (переменные +
 * метаданные: формат, путь, найден ли CLI, флаг readOnly). Запись — bulk: PUT
 * сохраняет полный желаемый набор пар (add/edit/delete на клиенте сводятся к нему).
 */

async function getProviderEnv(): Promise<ProviderEnvInfo> {
  const { data } = await apiClient.get<ProviderEnvInfo>('/provider-env');
  return data;
}

export function useProviderEnv() {
  return useQuery({ queryKey: queryKeys.providerEnv, queryFn: getProviderEnv });
}

/** Bulk-сохранение полного набора переменных. Инвалидирует раздел + сводку. */
export function useSaveProviderEnv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: ProviderEnvVar[]): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>('/provider-env', { vars });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerEnv });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
