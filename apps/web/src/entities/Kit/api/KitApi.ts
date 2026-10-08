import { useQuery } from '@tanstack/react-query';
import type { KitResponse } from '@agentdeck/contracts/kit';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getKit(): Promise<KitResponse> {
  const { data } = await apiClient.get<KitResponse>('/kit');
  return data;
}

export function useKit() {
  return useQuery({ queryKey: queryKeys.kit, queryFn: getKit });
}
