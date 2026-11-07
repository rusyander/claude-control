import { useQuery } from '@tanstack/react-query';
import type { ModelCatalogResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getModels(provider: string | undefined): Promise<ModelCatalogResponse> {
  const { data } = await apiClient.get<ModelCatalogResponse>('/models', {
    ...(provider ? { params: { provider } } : {}),
  });
  return data;
}

/**
 * Каталог моделей активного провайдера, а с `provider` — каталог этого CLI (шапка чата берёт
 * каталог CLI разговора, W3-17a: разговор Codex при активном Claude не предлагает моделей Claude).
 *
 * Запрашивается при открытии панели: сервер сам решает, идти ли в сеть (не чаще
 * раза в сутки) или отдать кэш, поэтому фронту достаточно обычного запроса.
 * `staleTime` крупный — в пределах сессии список не меняется. Ключ под корнем `models`: смена
 * провайдера сбрасывает и каталоги по имени.
 */
export function useModelCatalog(provider?: string) {
  return useQuery({
    queryKey: provider ? [...queryKeys.models, provider] : queryKeys.models,
    queryFn: () => getModels(provider),
    staleTime: 10 * 60 * 1000,
  });
}
