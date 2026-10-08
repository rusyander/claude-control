import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestImpact } from '@agentdeck/contracts';

/** Кейсы, задетые правками рабочей копии, — основа кнопки «только изменённое». */
export function useTestImpact(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.impact(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestImpact>('/project-tests/impact', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
