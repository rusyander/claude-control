import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SearchResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Глобальный поиск по разделам конфигурации. Запрос уходит на сервер, который
 * агрегирует все разделы и фильтрует по строке. Слишком короткий запрос на
 * сервер не отправляем — он всё равно вернул бы пустой результат.
 *
 * Кроме конфигурации, поиск отвечает и по тест-кейсам — но они лежат в самом
 * проекте, а не в `~/.claude`, поэтому проект называет клиент (`path`). Без него
 * выдача ровно прежняя.
 */

/** Ниже этого порога поиск не запускаем — совпадает с порогом на сервере. */
export const MIN_SEARCH_LENGTH = 2;

async function fetchSearch(query: string, projectPath?: string): Promise<SearchResponse> {
  const { data } = await apiClient.get<SearchResponse>('/search', {
    params: { q: query, ...(projectPath ? { path: projectPath } : {}) },
  });
  return data;
}

export function useSearch(query: string, projectPath?: string) {
  const normalized = query.trim();
  const enabled = normalized.length >= MIN_SEARCH_LENGTH;

  return useQuery({
    queryKey: queryKeys.search(normalized, projectPath),
    queryFn: () => fetchSearch(normalized, projectPath),
    enabled,
    // Прежние результаты держим на экране, пока грузятся новые — список не
    // мигает пустотой на каждый набранный символ.
    placeholderData: keepPreviousData,
  });
}
