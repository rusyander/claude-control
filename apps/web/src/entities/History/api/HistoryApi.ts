import { useQuery } from '@tanstack/react-query';
import type { HistoryResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Лента изменений конфигурации и дифф отдельной копии. Читающие запросы без
 * побочных эффектов: сервер собирает ленту из резервных копий. Полный дифф
 * грузится лениво — только когда запись в ленте раскрыта.
 */

async function fetchHistory(): Promise<HistoryResponse> {
  const { data } = await apiClient.get<HistoryResponse>('/history');
  return data;
}

export function useHistory() {
  return useQuery({ queryKey: queryKeys.history, queryFn: fetchHistory });
}
