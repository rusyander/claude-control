/**
 * Относительное время появления уведомления: «только что», «5 мин назад».
 * Формат зависит от языка интерфейса, поэтому язык приходит параметром.
 */
export function formatRelative(at: number, now: number, language: string): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);

  if (abs < 45) return format.format(0, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}
