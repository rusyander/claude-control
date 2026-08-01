import type { AnalyticsPreset } from '@entities/Analytics';

/** Ноль — «за всё время»: сервер понимает его как отсутствие ограничения. */
export const PRESETS: AnalyticsPreset[] = ['today', 7, 30, 90, 0];
