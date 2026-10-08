import type { DateRangeValue } from './date-picker.types';
import { parseLocalDay } from './date-picker.lib';

/**
 * Подпись на кнопке. Одни сутки показываем одной датой, а не «31 авг. — 31 авг.»:
 * повтор читается как ошибка ввода, хотя выбор именно такой и задумывался.
 */
export function formatValueLabel(
  value: DateRangeValue,
  locale: string,
  placeholder: string,
): string {
  const from = parseLocalDay(value.from);
  const to = parseLocalDay(value.to);
  if (!from && !to) return placeholder;

  const show = (date: Date): string =>
    date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

  if (from && to) return value.from === value.to ? show(from) : `${show(from)} — ${show(to)}`;
  // Половина диапазона: до второго клика показываем открытый край.
  return `${show((from ?? to) as Date)} — …`;
}
