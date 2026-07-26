/**
 * Период аналитики. Пресет — быстрая кнопка («сегодня», 7/30/90 дней, всё
 * время), диапазон — произвольные даты из пикера. Одно значение вместо пары
 * «дни + даты»: два независимых состояния разъезжались бы, и было бы неясно,
 * что именно показано.
 */
export type AnalyticsPreset = 'today' | 7 | 30 | 90 | 0;

export type AnalyticsPeriod =
  | { kind: 'preset'; preset: AnalyticsPreset }
  /** Границы — местные календарные дни `YYYY-MM-DD`, обе включительно. */
  | { kind: 'range'; from: string; to: string };

/** По умолчанию открываем текущие сутки: расход «прямо сейчас» — частый вопрос. */
export const DEFAULT_PERIOD: AnalyticsPeriod = { kind: 'preset', preset: 'today' };

/** Параметры запроса: сервер понимает либо `days`, либо пару `from`/`to`. */
export function periodParams(period: AnalyticsPeriod): Record<string, string> {
  return period.kind === 'range'
    ? { from: period.from, to: period.to }
    : { days: String(period.preset) };
}

/** Ключ кэша запроса и суффикс имени выгружаемого файла. */
export function periodKey(period: AnalyticsPeriod): string {
  if (period.kind === 'range') return `${period.from}_${period.to}`;
  if (period.preset === 0) return 'all';
  if (period.preset === 'today') return 'today';
  return `${period.preset}d`;
}
