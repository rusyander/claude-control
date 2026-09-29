/**
 * Срок сброса лимита для подписи группы: сегодня — только часы, иначе — с
 * датой. Недельный лимит сбрасывается через дни, и «до 08:00» читалось как
 * «сегодня утром» (живой прогон 29.09). Язык интерфейса, а не браузера (F-323).
 */
export function limitTime(iso: string, locale: string, now: Date = new Date()): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const clock = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return clock;
  const day = at.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  return `${clock}, ${day}`;
}
