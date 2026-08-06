import type { DateRangeValue } from './date-picker.types';

/**
 * `YYYY-MM-DD` → полночь ЭТИХ суток в местном поясе.
 *
 * Через конструктор с числами, а не через разбор строки: `new Date('2026-08-30')`
 * трактуется как UTC и в поясе +3 указывает на 29 августа.
 */
export function parseLocalDay(value?: string): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Обратное преобразование: местные сутки → `YYYY-MM-DD` без сдвига в UTC. */
export function formatLocalDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Сегодняшние сутки в том же формате — типовая верхняя граница выбора. */
export function todayIso(): string {
  return formatLocalDay(new Date());
}

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
