import type { SubscriptionHoldReason } from '@agentdeck/contracts/portable-subscribe';

export function holdLabelKey(reason: SubscriptionHoldReason): string {
  return `portability.subscription.hold.${reason}`;
}
