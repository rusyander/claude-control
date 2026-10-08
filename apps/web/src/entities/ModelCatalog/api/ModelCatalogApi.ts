import { useQuery } from '@tanstack/react-query';
import type { ModelCatalogResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getModels(): Promise<ModelCatalogResponse> {
  const { data } = await apiClient.get<ModelCatalogResponse>('/models');
  return data;
}

/**
 * Каталог моделей активного провайдера.
 *
 * Запрашивается при открытии панели: сервер сам решает, идти ли в сеть (не чаще
 * раза в сутки) или отдать кэш, поэтому фронту достаточно обычного запроса.
 * `staleTime` крупный — в пределах сессии список не меняется.
 */
export function useModelCatalog() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: getModels,
    staleTime: 10 * 60 * 1000,
  });
}
