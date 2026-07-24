import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderKeysResponse,
  ProviderKeyResult,
  ProviderRunnerInfo,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * API-ключи провайдеров и резолвинг раннера ассистента (Ф6a). Секреты наружу не
 * приходят: сервер отдаёт только маску (`sk-…last4`) и статус. Мутации возвращают
 * обновлённый маскированный статус, но не сам ключ.
 */

async function getProviderKeys(): Promise<ProviderKeysResponse> {
  const { data } = await apiClient.get<ProviderKeysResponse>('/provider-keys');
  return data;
}

export function useProviderKeys() {
  return useQuery({ queryKey: queryKeys.providerKeys, queryFn: getProviderKeys });
}

async function getProviderRunner(): Promise<ProviderRunnerInfo> {
  const { data } = await apiClient.get<ProviderRunnerInfo>('/provider-runner');
  return data;
}

/** Резолв раннера активного провайдера — чат по нему решает, показывать ли модалку. */
export function useProviderRunner() {
  return useQuery({ queryKey: queryKeys.providerRunner, queryFn: getProviderRunner });
}

/** Задать ключ провайдера. Инвалидирует список ключей и резолв раннера. */
export function useSaveProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; key: string }): Promise<ProviderKeyResult> => {
      const { data } = await apiClient.put<ProviderKeyResult>(
        `/provider-keys/${encodeURIComponent(input.providerId)}`,
        { key: input.key },
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerRunner });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

/** Очистить ключ провайдера. Инвалидирует список ключей и резолв раннера. */
export function useClearProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string): Promise<ProviderKeyResult> => {
      const { data } = await apiClient.delete<ProviderKeyResult>(
        `/provider-keys/${encodeURIComponent(providerId)}`,
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerRunner });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}
