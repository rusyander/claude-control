import { useQuery } from '@tanstack/react-query';
import type { GroupPathView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// «Путь» группы: собранный сервером список шагов, правка своих шагов одним
// запросом, ассистент шага и «повышение» шага до настоящего ресурса.

async function getPath(id: string): Promise<GroupPathView> {
  const { data } = await apiClient.get<GroupPathView>(`/groups/${id}/path`);
  return data;
}

/** Порядок шагов собирает сервер (`buildPath`) — клиент его не пересчитывает. */
export function useGroupPath(id: string) {
  return useQuery({ queryKey: queryKeys.groupPath(id), queryFn: () => getPath(id) });
}
