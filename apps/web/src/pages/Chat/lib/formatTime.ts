/**
 * Время сброса лимита короткой подписью «чч:мм».
 *
 * `locale` — язык интерфейса (`i18n.language`), а не браузера: русский
 * интерфейс в английском браузере показывал «03:04 PM» (F-323).
 */
export function formatTime(unixSeconds: number, locale: string): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
