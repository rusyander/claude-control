import { formatLocalDay } from './formatLocalDay';

/** Сегодняшние сутки в том же формате — типовая верхняя граница выбора. */
export function todayIso(): string {
  return formatLocalDay(new Date());
}
