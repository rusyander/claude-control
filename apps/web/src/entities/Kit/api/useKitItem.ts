import type { KitItemContent } from '@agentdeck/contracts/kit';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getItem(id: string): Promise<KitItemContent> {
  const { data } = await apiClient.get<KitItemContent>('/kit/item', { params: { id } });
  return data;
}

export function useKitItem(id: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.kit, 'item', id ?? ''],
    queryFn: () => getItem(id ?? ''),
    enabled: Boolean(id),
  });
}
