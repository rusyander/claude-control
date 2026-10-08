import type { AnalyticsPeriod } from './api.types';

/** Ключ кэша: тот же принцип, что в панели. */
export function periodKey(period: AnalyticsPeriod): string {
  if (period.kind === 'range') {
    return period.from === period.to ? period.from : `${period.from}_${period.to}`;
  }
  return period.preset;
}
