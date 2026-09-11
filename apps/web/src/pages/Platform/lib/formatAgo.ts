import type { TFunction } from 'i18next';
import { formatDateTime } from '@shared/lib/format';

/**
 * Когда это было — словами. «Проверен 2 мин назад» человек читает мгновенно, а
 * «10.09.2026, 14:03» приходится сравнивать с часами на стене.
 *
 * Дальше суток — обычная дата: «29 ч назад» уже не помогает, а вводит в
 * заблуждение, потому что пропускает границу дня.
 */
export function formatAgo(iso: string, language: string, t: TFunction): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;

  const minutes = Math.floor((Date.now() - at) / 60_000);
  // Отрицательная разница — часы машины ушли назад или отметка пришла с другой
  // машины. «Через 3 минуты» в журнале выглядит поломкой, поэтому такое время
  // показывается как «только что», а не как будущее.
  if (minutes < 1) return t('platform.justNow');
  if (minutes < 60) return t('platform.minutesAgo', { count: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('platform.hoursAgo', { count: hours });

  return formatDateTime(iso, language);
}
