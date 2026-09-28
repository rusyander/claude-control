import type { Language } from '../config/i18n';

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

/** Момент из ISO-строки или миллисекунд; битое значение — `undefined`. */
function moment(at: string | number): Date | undefined {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * Время суток на языке ИНТЕРФЕЙСА приложения, а не системы телефона: русский
 * интерфейс на английском телефоне показывал «03:04 PM» (F-323). Битое значение
 * даёт пустоту, не «Invalid Date».
 */
export function formatClock(
  at: string | number,
  language: Language,
  { seconds = false }: { seconds?: boolean } = {},
): string {
  const date = moment(at);
  if (!date) return '';
  return date.toLocaleTimeString(language, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' as const } : {}),
  });
}

/** Дата со временем на языке интерфейса — та же граница, что у `formatClock`. */
export function formatDateTime(at: string | number, language: Language): string {
  const date = moment(at);
  return date ? date.toLocaleString(language) : '';
}
