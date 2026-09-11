import { useQuery } from '@tanstack/react-query';
import type { CompromiseView, CompromisesResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

async function getCompromises(): Promise<CompromiseView[]> {
  const { data } = await apiClient.get<CompromisesResponse>('/compromises');
  return data.items;
}

/**
 * Подписанные компромиссы. Список ведёт сервер, а не фронт: снятая подпись
 * обязана погаснуть на экране сама, без правки разметки.
 *
 * Реестр статичен в пределах версии панели, поэтому запрос не устаревает
 * никогда — иначе он перезапрашивался бы при каждом возврате в окно.
 */
export function useCompromises() {
  return useQuery({
    queryKey: queryKeys.compromises,
    queryFn: getCompromises,
    staleTime: Infinity,
  });
}
