import type { TFunction } from 'i18next';
import { formatDate } from '@shared/lib/format';
import { timeGroup } from './rows';

/**
 * Когда в чате последний раз говорили. Внутри часа — минуты, сегодня и вчера —
 * время, дальше — дата. Голая дата, как было раньше, у сегодняшних чатов
 * одинаковая, и понять порядок списка по ней невозможно.
 */
export function formatWhen(iso: string, language: string, t: TFunction): string {
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);

  if (minutes < 1) return t('chat.justNow');
  if (minutes < 60) return t('chat.minutesAgo', { count: minutes });

  const time = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const group = timeGroup(iso);

  if (group === 'today') return time;
  if (group === 'yesterday') return `${t('chat.yesterday')}, ${time}`;

  return formatDate(iso, language);
}
