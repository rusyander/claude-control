import { useQuery } from '@tanstack/react-query';
import type { CascadeRuleView } from '@agentdeck/contracts/model-cascade';
import { cascadeKey } from '../lib/cascadeKey';
import { apiClient } from '@shared/api/client';

export function useCascadeRule(path: string | undefined) {
  return useQuery({
    queryKey: cascadeKey(path),
    queryFn: async () => {
      const { data } = await apiClient.get<CascadeRuleView>('/chat/cascade', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}
