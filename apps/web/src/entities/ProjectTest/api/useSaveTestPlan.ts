import { usePlanMutation } from './usePlanMutation';
import type { ProjectTestPlan } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useSaveTestPlan(path: string | undefined) {
  return usePlanMutation(path, async (plan: ProjectTestPlan) => {
    const { data } = await apiClient.post<{ plans: ProjectTestPlan[] }>('/project-tests/plan', {
      path,
      plan,
    });
    return data.plans;
  });
}
