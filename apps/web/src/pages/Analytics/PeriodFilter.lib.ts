import type { AnalyticsPreset } from '@entities/Analytics';

/** Местная дата в формате `input[type=date]`: сутки те же, что в отчёте. */
export function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function presetLabel(preset: AnalyticsPreset): string {
  if (preset === 'today') return 'analytics.today';
  if (preset === 0) return 'analytics.allTime';
  return `analytics.days${preset}`;
}
