import type { ModelPricing, PricingEntry } from '@agentdeck/contracts';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { RoutePrice } from '@agentdeck/contracts/core/routes';
import { BUILT_IN_ENTRIES, costOf, findEntry, longCacheRate } from '@agentdeck/pricing/pricing';
import { RELATIVE_RATES, promptCost, type CacheRates, type UsageLike } from '../cost.ts';
import type { PricedTurn, PriceTable, SpendTotals, TurnPrice } from './price.types.ts';

/**
 * Цена хода по маршруту × версии модели (план s5 зона L, P127, P43). Деньги считает тот же пакет
 * цен, что и аналитика панели (`@agentdeck/pricing`), — пересчёт журнала ядра обязан сходиться
 * с панелью до цента, а вторая копия формулы разошлась бы молча. Запасной ставки нет: модель
 * без строки прайса остаётся токенами.
 */

const tokensOf = (u: UsageLike): number => u.input + u.cacheRead + u.cacheWrite + u.output;

/** Единицы окна подписки: тот же вес, каким судьи экономики меряют ход (вход = 1). */
export function windowUnits(u: UsageLike, rates: CacheRates = RELATIVE_RATES): number {
  return promptCost(u, rates) + u.output * rates.output;
}

/** Строка прайса или цена шлюза для модели на момент `at`; версия — чем именно оценено. */
export function versionPrice(
  model: string,
  table: PriceTable,
  at: number,
): { price: ModelPricing; version: string } | undefined {
  const name = model.toLowerCase();
  // Шлюз назвал цену своей модели точно — она точнее общего прайса (как и в панели).
  const declared =
    table.declared && Object.hasOwn(table.declared, name) ? table.declared[name] : undefined;
  if (declared) return { price: declared, version: `declared:${name}` };
  const entry = findEntry(model, table.entries ?? BUILT_IN_ENTRIES, at);
  return entry ? { price: entry.price, version: versionLabel(entry) } : undefined;
}

/** У одной модели строки прайса делятся датами (вводная цена) — дата входит в имя версии. */
function versionLabel(entry: PricingEntry): string {
  if (entry.from) return `${entry.id}@${entry.from}`;
  if (entry.until) return `${entry.id}..${entry.until}`;
  return entry.id;
}

export function priceOf(
  routePrice: Fact<RoutePrice>,
  model: string,
  usage: UsageLike,
  at: number,
  table: PriceTable = {},
): TurnPrice {
  const tokens = tokensOf(usage);
  if ('unknown' in routePrice) return { unit: 'tokens', tokens, reason: 'unknown-price' };
  if ('absent' in routePrice) return { unit: 'tokens', tokens, reason: 'no-price' };
  const unit = routePrice.value.unit;
  if (unit === 'window') return { unit: 'window', units: windowUnits(usage) };
  if (unit === 'gpu-time') return { unit: 'tokens', tokens, reason: 'gpu-time' };
  if (unit === 'none') return { unit: 'tokens', tokens, reason: 'no-price' };
  if (model === 'unknown') return { unit: 'tokens', tokens, reason: 'unknown-model' };
  const found = versionPrice(model, table, at);
  if (!found) return { unit: 'tokens', tokens, reason: 'unknown-price' };
  const usd = costOf(found.price, {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheWrite,
    cacheCreation1h: usage.cacheWrite1h,
  });
  return { unit: 'money', usd, version: found.version };
}

/**
 * Отношения цен маршрута для судей экономики (`cost.ts`): деньги с известной ценой дают свои
 * отношения к входу, всё прочее — общие `RELATIVE_RATES`.
 */
export function ratesOf(
  routePrice: Fact<RoutePrice>,
  model: string,
  at: number,
  table: PriceTable = {},
): CacheRates {
  if (!('value' in routePrice) || routePrice.value.unit !== 'money') return RELATIVE_RATES;
  const found = versionPrice(model, table, at);
  if (!found || found.price.input <= 0) return RELATIVE_RATES;
  const p = found.price;
  return {
    input: 1,
    read: p.cacheRead / p.input,
    write: p.cacheWrite / p.input,
    write1h: longCacheRate(p) / p.input,
    output: p.output / p.input,
  };
}

/**
 * Ходы из строк журнала: строка того же `sessionId|messageId` заменяет прежнюю (как в свёртке v7),
 * момент цены — момент последней строки хода.
 */
export function turnsOfLines(lines: readonly JournalLine[]): PricedTurn[] {
  const byKey = new Map<string, PricedTurn>();
  for (const line of lines) {
    if (line.kind !== 'turn.usage') continue;
    const d = (line as JournalLine<'turn.usage'>).data;
    const key = `${d.sessionId}|${d.messageId}`;
    byKey.delete(key);
    byKey.set(key, { routeId: d.routeId, model: d.model, usage: d, at: line.at });
  }
  return [...byKey.values()];
}

/** Расход ходов по фактам цены маршрутов; деньги, окно и токены без цены не смешиваются. */
export function spendOf(
  turns: readonly PricedTurn[],
  priceFor: (routeId: string, model: string) => Fact<RoutePrice>,
  table: PriceTable = {},
): SpendTotals {
  const out: SpendTotals = { usd: 0, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 0 };
  for (const t of turns) {
    const p = priceOf(priceFor(t.routeId, t.model), t.model, t.usage, t.at, table);
    out.turns += 1;
    if (p.unit === 'money') {
      out.usd += p.usd;
      out.versions[p.version] = (out.versions[p.version] ?? 0) + 1;
    } else if (p.unit === 'window') out.windowUnits += p.units;
    else out.unpricedTokens += p.tokens;
  }
  return out;
}
