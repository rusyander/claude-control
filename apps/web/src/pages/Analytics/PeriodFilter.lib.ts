import type { AnalyticsPreset } from '@entities/Analytics';

export function presetLabel(preset: AnalyticsPreset): string {
  if (preset === 'today') return 'analytics.today';
  if (preset === 0) return 'analytics.allTime';
  return `analytics.days${preset}`;
}
