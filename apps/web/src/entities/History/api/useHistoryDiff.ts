import type { HistoryDiff } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function fetchDiff(name: string): Promise<HistoryDiff> {
  const { data } = await apiClient.get<HistoryDiff>('/history/diff', { params: { name } });
  return data;
}

/** Дифф конкретной копии. Запрос уходит только при заданном имени (раскрытая запись). */
export function useHistoryDiff(name: string | undefined) {
  return useQuery({
    queryKey: queryKeys.historyDiff(name ?? ''),
    queryFn: () => fetchDiff(name!),
    enabled: Boolean(name),
  });
}
