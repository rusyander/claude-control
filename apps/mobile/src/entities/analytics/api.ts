import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Analytics } from '@claude-control/contracts';
import { api } from '../../shared/api/client';

/**
 * Аналитика по транскриптам: расход, модели, проекты, инструменты.
 *
 * Считает всё сервер — он же сканирует файлы. Приложение только показывает: в
 * противном случае телефон и браузер расходились бы в цифрах, и доверия не
 * заслуживал бы ни один.
 *
 * Период устроен как в панели: либо пресет-кнопка, либо произвольный диапазон
 * дат. Одно значение вместо пары «дни + даты» — два независимых состояния
 * разъезжались бы, и было бы неясно, что именно показано.
 */

/** `today` — календарные сутки целиком, `0` — за всё время. */
export type AnalyticsPreset = 'today' | '7' | '30' | '90' | '0';

export type AnalyticsPeriod =
  | { kind: 'preset'; preset: AnalyticsPreset }
  /** Границы — местные календарные дни `YYYY-MM-DD`, обе включительно. */
  | { kind: 'range'; from: string; to: string };

export const DEFAULT_PERIOD: AnalyticsPeriod = { kind: 'preset', preset: '7' };

/** Параметры запроса: сервер понимает либо `days`, либо пару `from`/`to`. */
export function periodParams(period: AnalyticsPeriod): Record<string, string> {
  return period.kind === 'range' ? { from: period.from, to: period.to } : { days: period.preset };
}

/** Ключ кэша: тот же принцип, что в панели. */
export function periodKey(period: AnalyticsPeriod): string {
  if (period.kind === 'range') {
    return period.from === period.to ? period.from : `${period.from}_${period.to}`;
  }
  return period.preset;
}

export function useAnalytics(period: AnalyticsPeriod): UseQueryResult<Analytics> {
  return useQuery({
    queryKey: ['analytics', periodKey(period)],
    queryFn: () => api.get<Analytics>('/analytics', periodParams(period)),
    // Скан транскриптов не бесплатен, а цифры за сутки не меняются посекундно.
    staleTime: 60_000,
  });
}
