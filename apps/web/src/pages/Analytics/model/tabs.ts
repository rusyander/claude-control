import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Аналитика». Первые четыре — разрезы ОДНОГО отчёта за период
 * (прошлое, посчитанное по транскриптам); «Агенты и контур» — настоящее и то,
 * что считается не по транскриптам, поэтому период на неё не влияет.
 * `id` попадает в адрес (`/analytics?tab=…`).
 */
export const ANALYTICS_TABS = ['overview', 'breakdown', 'activity', 'sessions', 'live'] as const;

export type AnalyticsTabId = (typeof ANALYTICS_TABS)[number];

export const ANALYTICS_TAB_ICONS: Record<AnalyticsTabId, IconName> = {
  overview: 'overview',
  breakdown: 'analytics',
  activity: 'calendar',
  sessions: 'history',
  live: 'eye',
};

/** Вкладка показывает отчёт за период — ей нужны данные сканирования. */
export function isReportTab(tab: AnalyticsTabId): boolean {
  return tab !== 'live';
}
