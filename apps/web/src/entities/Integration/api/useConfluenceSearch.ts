import { useQuery } from '@tanstack/react-query';
import { integrationKeys } from './keys';
import type { ConfluencePage } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { SEARCH_LIMIT } from './IntegrationSearchApi.constants';

export function useConfluenceSearch(query: string) {
  return useQuery({
    queryKey: integrationKeys.confluenceSearch(query),
    queryFn: async (): Promise<ConfluencePage[]> => {
      const { data } = await apiClient.get<ConfluencePage[]>('/integrations/confluence/search', {
        params: { q: query, limit: SEARCH_LIMIT },
      });
      return data;
    },
    enabled: query.trim().length > 0,
  });
}
