import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SearchResponse } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Глобальный поиск по разделам конфигурации. Запрос уходит на сервер, который
 * агрегирует все разделы и фильтрует по строке. Слишком короткий запрос на
 * сервер не отправляем — он всё равно вернул бы пустой результат.
 */

/** Ниже этого порога поиск не запускаем — совпадает с порогом на сервере. */
export const MIN_SEARCH_LENGTH = 2;

async function fetchSearch(query: string): Promise<SearchResponse> {
  const { data } = await apiClient.get<SearchResponse>('/search', { params: { q: query } });
  return data;
}

export function useSearch(query: string) {
  const normalized = query.trim();
  const enabled = normalized.length >= MIN_SEARCH_LENGTH;

  return useQuery({
    queryKey: queryKeys.search(normalized),
    queryFn: () => fetchSearch(normalized),
    enabled,
    // Прежние результаты держим на экране, пока грузятся новые — список не
    // мигает пустотой на каждый набранный символ.
    placeholderData: keepPreviousData,
  });
}
