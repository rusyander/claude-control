import type { ModelPricing, PricingEntry } from '@agentdeck/contracts';
import type { HopMoneyReason, HopPriceSpec } from '@agentdeck/contracts/core/hops';
import { BUILT_IN_ENTRIES, costOf, findEntry } from '@agentdeck/pricing/pricing';
import type { SpendUsage } from './spend.types.ts';

/**
 * Деньги одного ответа на звене (P127): маршрут × версия модели по тому же пакету цен и в том же
 * порядке, что `economy/price` ядра (`priceOf`/`versionPrice`). Хост не импортирует экономику
 * ядра (depcruise `core-hop-host-thin`), поэтому ветвление повторено здесь, а формула и таблица —
 * общие из `@agentdeck/pricing`; расхождение двух копий ловит `price.test.ts` сверкой с ядром.
 * Запасной ставки нет: модель без строки прайса — `null` с причиной, не число.
 */

export type HopPrice = { money: number; version: string } | { money: null; reason: HopMoneyReason };

function versionPrice(
  model: string,
  spec: HopPriceSpec,
  at: number,
): { price: ModelPricing; version: string } | undefined {
  const name = model.toLowerCase();
  // Шлюз назвал цену своей модели точно — она точнее общего прайса (как в ядре и панели).
  const declared =
    spec.declared && Object.hasOwn(spec.declared, name) ? spec.declared[name] : undefined;
  if (declared) return { price: declared, version: `declared:${name}` };
  const entry = findEntry(model, spec.entries ?? BUILT_IN_ENTRIES, at);
  return entry ? { price: entry.price, version: versionLabel(entry) } : undefined;
}

/** У одной модели строки прайса делятся датами (вводная цена) — дата входит в имя версии. */
function versionLabel(entry: PricingEntry): string {
  if (entry.from) return `${entry.id}@${entry.from}`;
  if (entry.until) return `${entry.id}..${entry.until}`;
  return entry.id;
}

export function hopPriceOf(
  spec: HopPriceSpec | null,
  model: string,
  usage: SpendUsage,
  at: number,
): HopPrice {
  if (spec === null) return { money: null, reason: 'no-price-fact' };
  const fact = spec.route;
  if ('unknown' in fact) return { money: null, reason: 'unknown-price' };
  if ('absent' in fact) return { money: null, reason: 'no-price' };
  const unit = fact.value.unit;
  if (unit === 'window') return { money: null, reason: 'window' };
  if (unit === 'gpu-time') return { money: null, reason: 'gpu-time' };
  if (unit === 'none') return { money: null, reason: 'no-price' };
  if (model === 'unknown') return { money: null, reason: 'unknown-model' };
  const found = versionPrice(model, spec, at);
  if (!found) return { money: null, reason: 'unknown-price' };
  const money = costOf(found.price, {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheWrite,
    cacheCreation1h: usage.cacheWrite1h,
  });
  return { money, version: found.version };
}
