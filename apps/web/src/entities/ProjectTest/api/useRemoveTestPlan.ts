import { usePlanMutation } from './usePlanMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestPlan } from '@agentdeck/contracts';

export function useRemoveTestPlan(path: string | undefined) {
  return usePlanMutation(path, async (id: string) => {
    const { data } = await apiClient.delete<{ plans: ProjectTestPlan[] }>('/project-tests/plan', {
      params: { path, id },
    });
    return data.plans;
  });
}
