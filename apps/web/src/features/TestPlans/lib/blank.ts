import type { ProjectTestPlan } from '@agentdeck/contracts';

export function blank(): ProjectTestPlan {
  return {
    id: `plan-${Date.now().toString(36)}`,
    title: '',
    caseIds: [],
    environmentIds: [],
    createdAt: new Date().toISOString(),
  };
}
