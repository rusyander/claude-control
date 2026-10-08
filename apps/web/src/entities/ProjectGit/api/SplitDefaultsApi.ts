import { useQuery } from '@tanstack/react-query';
import type { SplitDefaultsView } from '@agentdeck/contracts/split-groups';
import { apiClient } from '@shared/api/client';
import { splitDefaultsKey } from './SplitDefaultsApi.constants';

export function useSplitDefaults() {
  return useQuery({
    queryKey: splitDefaultsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<SplitDefaultsView>('/split-defaults');
      return data;
    },
  });
}
