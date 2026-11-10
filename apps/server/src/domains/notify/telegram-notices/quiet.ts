import type { TelegramSettings } from '@agentdeck/contracts';

/**
 * Тихие часы Telegram (этап 12, P194): окно `[from, to)` по местным часам машины панели. Окно
 * может переходить через полночь (`23:00–08:00`); `from === to` — тишины нет (пустое окно, а не
 * сутки: «тихо всегда» значило бы «бот молчит», для этого есть выключатель карточки).
 *
 * Модуль чистый: часы приходят параметром — проверки подменяют их, не трогая таймеров.
 */

export type QuietSetting = NonNullable<TelegramSettings['quiet']>;

export interface QuietNow {
  /** Сейчас тихо. */
  inside: boolean;
  /** Когда кончится текущее окно (мс эпохи); вне окна — `null`. */
  endsAt: number | null;
}

function minutesOf(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Где мы относительно окна тишины в момент `now`; настройки нет или она кривая — не тихо. */
export function quietAt(quiet: QuietSetting | undefined, now: number): QuietNow {
  const from = quiet ? minutesOf(quiet.from) : null;
  const to = quiet ? minutesOf(quiet.to) : null;
  if (from === null || to === null || from === to) return { inside: false, endsAt: null };
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  const wraps = from > to;
  const inside = wraps ? minute >= from || minute < to : minute >= from && minute < to;
  if (!inside) return { inside: false, endsAt: null };
  // Конец окна: сегодня в `to`, а если `to` уже прошло (окно через полночь, сейчас вечер) — завтра.
  const end = new Date(now);
  end.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (end.getTime() <= now) end.setDate(end.getDate() + 1);
  return { inside: true, endsAt: end.getTime() };
}
