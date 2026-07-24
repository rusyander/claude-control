import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderPermissionInfo,
  ProviderPermissionDraft,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Универсальные права/аппрувы активного провайдера (Codex). Отдельный от Claude
 * набор запросов: права Claude живут на своих богатых роутах (settings.json
 * allow/deny/ask) со своей страницей — клиент выбирает набор по активному
 * провайдеру. GET возвращает `ProviderPermissionInfo` (текущие значения +
 * допустимые наборы + метаданные). PUT сохраняет оба скалярных ключа корня.
 */

async function getProviderPermissions(): Promise<ProviderPermissionInfo> {
  const { data } = await apiClient.get<ProviderPermissionInfo>('/provider-permissions');
  return data;
}

export function useProviderPermissions() {
  return useQuery({
    queryKey: queryKeys.providerPermissions,
    queryFn: getProviderPermissions,
  });
}

/** Сохранить оба ключа прав. Инвалидирует раздел + сводку. */
export function useSaveProviderPermissions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderPermissionDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>('/provider-permissions', draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerPermissions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
