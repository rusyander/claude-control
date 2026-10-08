import type { ModelPricing, PricingEntry } from '@agentdeck/contracts';
import { PRICING_FIELDS } from './PricingRow.constants';

export function samePrice(a: ModelPricing, b: ModelPricing): boolean {
  return PRICING_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Свои цены после сохранения строки. Прежние ключи-фрагменты («opus») убираем:
 * иначе рядом жили бы две своих цены на одну модель, и какая победит — зависело
 * бы от порядка ключей. Совпало с прайсом — не храним вовсе: пусть работает
 * цена с сайта, тогда обновление принесёт свежую само.
 */
export function nextCustom(
  custom: Record<string, ModelPricing>,
  entry: PricingEntry,
  price: ModelPricing,
): Record<string, ModelPricing> {
  const next = Object.fromEntries(
    Object.entries(custom).filter(([fragment]) => !entry.id.includes(fragment)),
  );

  if (!samePrice(price, entry.price)) next[entry.id] = price;
  return next;
}
