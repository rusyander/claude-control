import type { PricingDraft, PricingField } from './PricingRow.types';
import type { ModelPricing } from '@agentdeck/contracts';

export function parseRate(raw: string | undefined): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Цена из набранного. Мусор и отрицательные числа — не цена: сервер такое
 * отклонит, и молча «сохранённая» строка осталась бы прежней. Пустая часовая
 * ставка допустима — она необязательна, и её отсутствие означает «как введена
 * пятиминутная», а не ноль.
 */
export function priceFromDraft(draft: PricingDraft): ModelPricing | undefined {
  const required = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  const price: Partial<Record<PricingField, number>> = {};

  for (const field of required) {
    const value = parseRate(draft[field]);
    if (value === undefined) return undefined;
    price[field] = value;
  }

  const long = (draft.cacheWrite1h ?? '').trim();
  if (long) {
    const value = parseRate(long);
    if (value === undefined) return undefined;
    price.cacheWrite1h = value;
  }

  return price as ModelPricing;
}
