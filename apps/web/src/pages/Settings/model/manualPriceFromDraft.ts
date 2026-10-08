import type { PricingDraft } from './PricingRow.types';
import type { ModelPricing } from '@agentdeck/contracts';
import { priceFromDraft } from './priceFromDraft';

/**
 * Ручная цена из формы. Для модели компании обычно известны только вход и
 * выход: незаданный кэш берётся равным входу — так шлюз без отдельной цены кэша
 * и берёт деньги за эти токены (`declaredPricing` на сервере).
 */
export function manualPriceFromDraft(draft: PricingDraft): ModelPricing | undefined {
  const input = (draft.input ?? '').trim();
  const orInput = (value: string | undefined): string => ((value ?? '').trim() ? value! : input);
  return priceFromDraft({
    ...draft,
    cacheRead: orInput(draft.cacheRead),
    cacheWrite: orInput(draft.cacheWrite),
  });
}
