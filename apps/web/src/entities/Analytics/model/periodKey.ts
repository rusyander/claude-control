import type { AnalyticsPeriod } from './period.types';

/** Ключ кэша запроса и суффикс имени выгружаемого файла. */
export function periodKey(period: AnalyticsPeriod): string {
  // Одни сутки — одна дата в имени: `2026-08-30_2026-08-30` читается как ошибка
  // выгрузки, хотя период выбран именно такой.
  if (period.kind === 'range') {
    return period.from === period.to ? period.from : `${period.from}_${period.to}`;
  }
  if (period.preset === 0) return 'all';
  if (period.preset === 'today') return 'today';
  return `${period.preset}d`;
}
