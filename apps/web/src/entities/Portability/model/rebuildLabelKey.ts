import type { SubscriptionRebuildReason } from '@agentdeck/contracts/portable-subscribe';

export function rebuildLabelKey(reason: SubscriptionRebuildReason): string {
  return `portability.subscription.rebuild.${reason}`;
}
