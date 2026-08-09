/**
 * Числа на экран. Ровно те же правила, что в панели: телефон и браузер смотрят
 * на один и тот же расход, и разные округления читались бы как разные цифры.
 */

/** Токены и счётчики: `12.3k`, `1.2M`. */
export function compact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Расход в выбранных единицах — токены или деньги, как настроено в панели. */
export function formatSpend(unit: CostUnit, tokens: number, costUsd: number): string {
  return unit === 'money' ? `$${costUsd.toFixed(3)}` : `${compact(tokens)} tok`;
}

export type CostUnit = 'tokens' | 'money';
