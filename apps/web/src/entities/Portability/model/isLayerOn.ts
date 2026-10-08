import type { EnvSubscription } from '@agentdeck/contracts/portable-subscribe';
import type { EnvItemKind } from '@agentdeck/contracts/portable-env';

/** Подписан ли слой. Пустая подписка отвечает «нет» на каждый. */
export function isLayerOn(subscription: EnvSubscription | null, layer: EnvItemKind): boolean {
  return Boolean(subscription?.layers.includes(layer));
}
