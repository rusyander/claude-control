import { useQuery } from '@tanstack/react-query';
import type { JiraProject } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

export function useJiraProjects(isEnabled: boolean) {
  return useQuery({
    queryKey: integrationKeys.jiraProjects,
    queryFn: async (): Promise<JiraProject[]> => {
      const { data } = await apiClient.get<JiraProject[]>('/integrations/jira/projects');
      return data;
    },
    enabled: isEnabled,
  });
}
