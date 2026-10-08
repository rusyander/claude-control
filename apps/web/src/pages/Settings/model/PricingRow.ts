import type { ModelPricing } from '@agentdeck/contracts';
import { PRICING_FIELDS } from './PricingRow.constants';
import type { PricingDraft } from './PricingRow.types';

/** Форма для правки строки: пустое поле — «ставка неизвестна», а не ноль. */
export function draftFromPrice(price: ModelPricing): PricingDraft {
  const draft: PricingDraft = {};

  for (const field of PRICING_FIELDS) {
    const value = price[field];
    draft[field] = value === undefined ? '' : String(value);
  }

  return draft;
}
