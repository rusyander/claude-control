import type { ProjectTestPlan } from '@agentdeck/contracts';

/** Планы, которые останутся без окружения, если его убрать. */
export function plansUsingEnvironment(
  plans: ProjectTestPlan[],
  environmentId: string,
): ProjectTestPlan[] {
  return plans.filter((plan) => plan.environmentIds?.includes(environmentId));
}
