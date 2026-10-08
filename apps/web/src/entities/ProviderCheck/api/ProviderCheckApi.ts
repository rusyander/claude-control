import { useQuery } from '@tanstack/react-query';
import type { ProviderChecksResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getChecks(): Promise<ProviderChecksResponse> {
  const { data } = await apiClient.get<ProviderChecksResponse>('/providers/checks');
  return data;
}

/**
 * Итоги проверок провайдеров. Обычный запрос: сервер только читает сохранённое
 * состояние, ничего не запускает — значит, бейджи можно рисовать где угодно, не
 * опасаясь, что открытие раздела дёрнет CLI.
 */
export function useProviderChecks() {
  return useQuery({ queryKey: queryKeys.providerChecks, queryFn: getChecks });
}
