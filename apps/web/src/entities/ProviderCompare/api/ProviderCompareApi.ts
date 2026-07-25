import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ProviderCompareResponse,
  ProviderMigrateRequest,
  ProviderMigrateResponse,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getCompare(left: string, right: string): Promise<ProviderCompareResponse> {
  const { data } = await apiClient.get<ProviderCompareResponse>('/provider-compare', {
    params: { left, right },
  });
  return data;
}

async function postMigrate(request: ProviderMigrateRequest): Promise<ProviderMigrateResponse> {
  const { data } = await apiClient.post<ProviderMigrateResponse>('/provider-migrate', request);
  return data;
}

/**
 * Сравнение двух провайдеров. Обычный запрос: сервер только читает файлы, так
 * что открытие страницы ничего не меняет и ничего не запускает.
 */
export function useProviderCompare(left: string, right: string) {
  return useQuery({
    queryKey: queryKeys.providerCompare(left, right),
    queryFn: () => getCompare(left, right),
    enabled: Boolean(left) && Boolean(right) && left !== right,
  });
}

/**
 * Перенос записей. Одна и та же мутация служит и предпросмотру, и записи —
 * разница только в `mode`, и это сознательно: разойтись они не смогут.
 */
export function useMigrateProvider() {
  return useMutation({ mutationFn: postMigrate });
}
