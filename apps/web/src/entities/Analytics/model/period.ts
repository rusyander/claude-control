import type { AnalyticsPeriod } from './period.types';

/** По умолчанию открываем текущие сутки: расход «прямо сейчас» — частый вопрос. */
export const DEFAULT_PERIOD: AnalyticsPeriod = { kind: 'preset', preset: 'today' };

/** Параметры запроса: сервер понимает либо `days`, либо пару `from`/`to`. */
export function periodParams(period: AnalyticsPeriod): Record<string, string> {
  return period.kind === 'range'
    ? { from: period.from, to: period.to }
    : { days: String(period.preset) };
}
