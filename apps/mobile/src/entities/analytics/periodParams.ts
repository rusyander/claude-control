import type { AnalyticsPeriod } from './api.types';

/** Параметры запроса: сервер понимает либо `days`, либо пару `from`/`to`. */
export function periodParams(period: AnalyticsPeriod): Record<string, string> {
  return period.kind === 'range' ? { from: period.from, to: period.to } : { days: period.preset };
}
