import type { SubscriptionDriftResolution } from '@agentdeck/contracts/portable-subscribe';

export function resolutionTextKey(resolution: SubscriptionDriftResolution): string {
  return `portability.subscription.resolution.${resolution}.text`;
}
