import { useQuery } from '@tanstack/react-query';
import { integrationKeys } from './keys';
import type { JiraIssue } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { SEARCH_LIMIT } from './IntegrationSearchApi.constants';

export function useJiraSearch(query: string) {
  return useQuery({
    queryKey: integrationKeys.jiraSearch(query),
    queryFn: async (): Promise<JiraIssue[]> => {
      const { data } = await apiClient.get<JiraIssue[]>('/integrations/jira/search', {
        params: { q: query, limit: SEARCH_LIMIT },
      });
      return data;
    },
    enabled: query.trim().length > 0,
  });
}
