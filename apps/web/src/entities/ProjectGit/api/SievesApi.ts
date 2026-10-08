import { useQuery } from '@tanstack/react-query';
import type { SievesView } from '@agentdeck/contracts/sieves';
import { apiClient } from '@shared/api/client';
import { sievesKey } from './SievesApi.constants';

export function useSieves() {
  return useQuery({
    queryKey: sievesKey,
    queryFn: async () => {
      const { data } = await apiClient.get<SievesView>('/sieves');
      return data;
    },
  });
}
