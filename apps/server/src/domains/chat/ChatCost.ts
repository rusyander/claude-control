import type { ChatMessage } from '@claude-control/contracts';
import { estimateCost, type PricingLookup } from '../analytics/pricing.ts';

/**
 * Тарифы на момент запроса. Функция, а не таблица: прайс подтягивается в фоне,
 * а свои цены пользователь правит в настройках — запомненный снимок отстал бы.
 */
export type StepRates = () => Pick<PricingLookup, 'overrides' | 'entries'>;

/**
 * Дополнить расход шага ценой по тарифу его модели.
 *
 * Считается здесь, а не в истории: тарифы живут в кэше прайса и в настройках
 * пользователя, до которых история не добирается. Цена нужна как раз потому,
 * что по объёму токенов дешёвый шаг от дорогого не отличить — чтение кэша
 * стоит на порядок меньше свежего входа.
 *
 * Момент берём по времени самого сообщения: у моделей бывают вводные цены с
 * датой окончания, и старая переписка должна считаться по тем тарифам,
 * которые действовали тогда.
 */
export function createStepCost(rates: StepRates): (message: ChatMessage) => ChatMessage {
  return (message) => {
    const { usage } = message;
    if (!usage?.model) return message;

    const at = Date.parse(message.timestamp);
    const costUsd = estimateCost(usage.model, usage, {
      ...rates(),
      at: Number.isNaN(at) ? undefined : at,
    });

    return { ...message, usage: { ...usage, costUsd } };
  };
}
