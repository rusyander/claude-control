/**
 * Время суток из ISO-строки: `10:00:04`. Дата не нужна — подсказка бейджа
 * показывает границы шага, а шаг длиннее суток не бывает. Битая строка даёт
 * пустоту, не «Invalid Date».
 *
 * `locale` — язык интерфейса (`i18n.language`), а не браузера: русский
 * интерфейс в английском браузере показывал «10:00:04 AM» (F-323).
 */
export function formatClock(iso: string, locale: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
