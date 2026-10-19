import type { TFunction } from 'i18next';

/** С какого возраста вместо «N ч назад» пишется дата и время. */
const DATE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько прошло с события — грубо: `только что`, `36 мин назад`, `5 ч назад`,
 * старше суток — дата и время (`19 окт., 14:05`).
 *
 * Секунд нет нарочно (владелец 20.10): у того, что уже кончилось, точность до
 * секунды не нужна никому, а тикающее «36м 35с» только отвлекает.
 */
export function formatAgo(at: number, now: number, t: TFunction, language: string): string {
  const ms = Math.max(0, now - at);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t('common.ago.justNow');
  if (minutes < 60) return t('common.ago.minutes', { count: minutes });
  if (ms < DATE_AFTER_MS) return t('common.ago.hours', { count: Math.floor(minutes / 60) });
  const date = new Date(at).toLocaleString(language, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return t('common.ago.at', { date });
}
