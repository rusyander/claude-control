/**
 * Тарифы API за миллион токенов — нужны, чтобы перевести потраченные токены
 * в понятную величину.
 *
 * ВАЖНО: при подписке деньги за токены не списываются, лимиты считаются иначе.
 * Поэтому цифра стоимости — справочная: «столько же работы через API стоило бы
 * вот столько». Интерфейс обязан подписывать её как оценку, а не как счёт.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Ключ — фрагмент имени модели; ищем по вхождению, чтобы пережить смену суффиксов. */
const PRICING: Array<[string, ModelPricing]> = [
  ['opus', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['haiku', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
];

const FALLBACK: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

export function getPricing(model: string): ModelPricing {
  const name = model.toLowerCase();
  return PRICING.find(([fragment]) => name.includes(fragment))?.[1] ?? FALLBACK;
}

export function estimateCost(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number },
): number {
  const price = getPricing(model);
  const perMillion = 1_000_000;

  return (
    (tokens.input * price.input) / perMillion +
    (tokens.output * price.output) / perMillion +
    (tokens.cacheRead * price.cacheRead) / perMillion +
    (tokens.cacheCreation * price.cacheWrite) / perMillion
  );
}
