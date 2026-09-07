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

/**
 * Модель прогона для узкой шапки: `claude-sonnet-5` → `sonnet-5`.
 *
 * Режется только приставка вендора, и только у Claude: на экране панели Claude
 * она не значит ничего, а место в строке решает. Имя чужого CLI остаётся как
 * есть — там вендор и есть ответ на вопрос «чем это работает».
 */
export function shortModel(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}
