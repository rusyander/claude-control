import type { EnvSubscription } from '@agentdeck/contracts/portable-subscribe';

/**
 * Подписана ли цель хоть на что-нибудь.
 *
 * Отдельно от «запись подписки есть»: запись переживает отписку намеренно — в
 * ней лежит память о спроецированном, — и считать её наличие подпиской значило
 * бы показывать пересборку там, где человек от всего отписался.
 */
export function hasLayers(subscription: EnvSubscription | null): boolean {
  return Boolean(subscription && subscription.layers.length > 0);
}
