import type { ModelPricing, PricingEntry } from '@agentdeck/contracts';

/** Ручная цена: модель, которой в прайсе нет, и её ставки. */
export interface ManualPrice {
  /** Фрагмент имени, как его сверяет расчёт (`findPricing`): строчными. */
  model: string;
  price: ModelPricing;
}

/**
 * Свои цены, которые не относятся ни к одной строке прайса, — ручные.
 *
 * Решение по контуру №7: каталог платформы компании цены Qwen3.8 не отдаёт, и оценка
 * расхода через контур стояла на 0 $ при списании 0,46 $. Такой цене нет строки
 * в прайсе Anthropic — без этого списка она сохранялась бы и работала невидимой,
 * а человек не знал бы, по какой цифре считается оценка.
 */
export function manualPrices(
  custom: Record<string, ModelPricing>,
  entries: readonly PricingEntry[],
): ManualPrice[] {
  return Object.entries(custom)
    .filter(([fragment]) => !entries.some((entry) => entry.id.includes(fragment)))
    .map(([model, price]) => ({ model, price }))
    .sort((a, b) => a.model.localeCompare(b.model));
}
