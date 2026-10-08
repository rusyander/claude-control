import type { SubscriptionDriftResolution } from '@agentdeck/contracts/portable-subscribe';

export function resolutionLabelKey(resolution: SubscriptionDriftResolution): string {
  return `portability.subscription.resolution.${resolution}.title`;
}
