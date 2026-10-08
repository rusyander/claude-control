import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestTaxonomyPlan } from '@agentdeck/contracts';

export function useTestTaxonomy(path: string | undefined, minCases: number, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.taxonomy(path, minCases),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestTaxonomyPlan>('/project-tests/taxonomy', {
        params: { path, minCases },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
