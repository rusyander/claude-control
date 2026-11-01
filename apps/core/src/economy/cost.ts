import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';

/**
 * Счёт расхода хода в единицах цены входа (03 §Economy, G10). Судьи продолжения, бюджета и
 * прогрева сравнивают варианты одной меркой; деньги — дело цены маршрута (зона L, `priceOf`),
 * сюда приходят только ОТНОШЕНИЯ цен. Маршрут без кэша даёт `read = write = input`.
 */

export interface CacheRates {
  input: number;
  /** Чтение кэша. */
  read: number;
  /** Запись кэша с коротким сроком. */
  write: number;
  /** Запись кэша с часовым сроком: дороже короткой. */
  write1h: number;
  output: number;
}

/**
 * Отношения по умолчанию — до факта цены маршрута: чтение кэша — десятая доля входа, запись —
 * 1.25 (час — 2), выход — 5. Те же отношения, по которым панель считает вес окна; маршрут,
 * у которого факт цены есть, приходит своими.
 */
export const RELATIVE_RATES: CacheRates = {
  input: 1,
  read: 0.1,
  write: 1.25,
  write1h: 2,
  output: 5,
};

/** Короткий и часовой сроки кэша: какой у сессии — видно по доле часовой записи её ходов. */
export const CACHE_TTL_SHORT_MS = 5 * 60_000;
export const CACHE_TTL_LONG_MS = 60 * 60_000;

export type UsageLike = Pick<
  JournalDataV1['turn.usage'],
  'input' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'output'
>;

/** Токены бюджета (G10): вход + запись кэша + выход; чтение кэша — расход, но не бюджет. */
export function budgetTokens(u: UsageLike): number {
  return u.input + u.cacheWrite + u.output;
}

/** Размер запроса хода: всё, что модель прочла на входе (свежий вход, чтение и запись кэша). */
export function contextOf(u: UsageLike): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** Цена входа хода (без выхода): так меряется перенос контекста, а не работа модели. */
export function promptCost(u: UsageLike, rates: CacheRates = RELATIVE_RATES): number {
  const short = Math.max(0, u.cacheWrite - u.cacheWrite1h);
  return (
    u.input * rates.input +
    u.cacheRead * rates.read +
    short * rates.write +
    u.cacheWrite1h * rates.write1h
  );
}

/** Цена записи кэша на сроке сессии: часовой срок пишется по часовой цене. */
export function writeRate(ttlMs: number | null, rates: CacheRates = RELATIVE_RATES): number {
  return ttlMs !== null && ttlMs > CACHE_TTL_SHORT_MS ? rates.write1h : rates.write;
}

/** Квантиль по возрастанию (ближайший ранг): p10/p50/p90 оценок и бюджетов. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i] as number;
}
