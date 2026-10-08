import type { SubscriptionDriftState } from '@agentdeck/contracts/portable-subscribe';

export function driftStateLabelKey(state: SubscriptionDriftState): string {
  return `portability.subscription.drift.state.${state}`;
}
