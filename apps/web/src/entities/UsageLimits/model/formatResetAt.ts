/**
 * Момент сброса коротко: сегодня — только время («20:10»), иначе день недели и
 * время («пн 19:00»), дальше недели — дата. Язык — интерфейса, а не браузера
 * (F-323: русский интерфейс в английском браузере показывал «AM»).
 */
export function formatResetAt(resetsAt: number, now: number, locale: string): string {
  const at = new Date(resetsAt);
  const today = new Date(now);
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === today.toDateString()) return time;
  if (resetsAt - now < 6 * 24 * 60 * 60 * 1000) {
    return `${at.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  }
  return `${at.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })} ${time}`;
}
