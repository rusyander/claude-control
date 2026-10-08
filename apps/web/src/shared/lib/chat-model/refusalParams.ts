import type { PlatformRunPlan } from '@agentdeck/contracts';
import type { PlatformRefusalParams } from './index.types';

export function refusalParams(plan: PlatformRunPlan): PlatformRefusalParams {
  const reason =
    plan.reason === 'no_token' || plan.reason === 'cli_config_bypass'
      ? plan.reason
      : 'gateway_down';
  return { title: plan.title, reason, setting: plan.setting ?? '' };
}
