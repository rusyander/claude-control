import type { TFunction } from 'i18next';

/** Сколько до сброса: «4 д 3 ч», «1 ч 35 мин», «12 мин», «меньше минуты». */
export function formatUntil(ms: number, t: TFunction): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t('usageLimits.until.soon');
  if (minutes < 60) return t('usageLimits.until.minutes', { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('usageLimits.until.hours', { h: hours, m: minutes % 60 });
  return t('usageLimits.until.days', { d: Math.floor(hours / 24), h: hours % 24 });
}
