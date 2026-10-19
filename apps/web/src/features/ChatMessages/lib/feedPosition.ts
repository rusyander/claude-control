import type { FeedAnchor, FeedProbe, FeedRow, FeedSnapshot } from './feedPosition.types';

/**
 * Память места в ленте на разговор — на время жизни вкладки.
 *
 * Зачем: человек листает родителя разделения, открывает ребёнка из сводки и
 * возвращается — а лента родителя уже стоит в самом низу, и место, где он
 * читал, надо искать заново. Это повторяется на каждый переход, а детей у
 * родителя бывает по полтора десятка.
 *
 * Память живёт в sessionStorage вкладки (владелец 20.10): после перезагрузки
 * страницы родитель встаёт туда, где человек читал, а не в самый низ — раньше
 * место помнила только память модуля, и каждое F5 бросало вниз. Новая вкладка
 * открывает разговор у низа, как и раньше. Разговор, который человек не листал
 * (стоял у низа), не запоминается вовсе и при возврате по-прежнему едет за
 * ответом.
 *
 * Место держим якорем «сообщение + сдвиг», а не голым `scrollTop`: пока
 * человек был у ребёнка, в родителя дописывались сообщения, а окно последних
 * N сообщений при этом сдвигается сверху — голая прокрутка уехала бы на чужое.
 */

/**
 * Сколько разговоров помним. Больше, чем человек обходит за сессию (родитель и
 * полтора десятка детей), и мало, чтобы память не росла без конца в вкладке,
 * открытой неделями: самый давний выпадает первым.
 */
export const FEED_MEMORY_LIMIT = 50;

/** Порог «у низа», px: ближе — лента держится низа (тот же, что был в прокрутке ленты). */
export const PINNED_THRESHOLD = 160;

/** Хранилище, переживающее перезагрузку: sessionStorage вкладки или подмена в тесте. */
export interface FeedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** sessionStorage, если он есть и доступен (приватный режим, node-тесты — нет). */
function sessionStore(): FeedStorage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Память «id разговора → значение» с вытеснением самого давнего. С `persist`
 * — ещё и в хранилище под этим ключом: прочитана при создании, переписана на
 * каждом изменении. Битая или чужая запись — пустая память, а не сбой ленты.
 */
export function createFeedMemory<T>(
  limit = FEED_MEMORY_LIMIT,
  persist?: { key: string; storage?: FeedStorage },
) {
  const storage = persist ? (persist.storage ?? sessionStore()) : undefined;
  const entries = new Map<string, T>(load<T>(storage, persist?.key).slice(-limit));
  const save = (): void => {
    if (!storage || !persist) return;
    try {
      storage.setItem(persist.key, JSON.stringify([...entries]));
    } catch {
      // Переполнено или запрещено — место просто не переживёт перезагрузку.
    }
  };
  return {
    get: (id: string): T | undefined => entries.get(id),
    set: (id: string, value: T): void => {
      // Переставляем в конец: «давность» считается по последней записи, а не по первой.
      entries.delete(id);
      entries.set(id, value);
      if (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      save();
    },
    delete: (id: string): void => {
      if (entries.delete(id)) save();
    },
    size: (): number => entries.size,
  };
}

function load<T>(storage: FeedStorage | undefined, key: string | undefined): [string, T][] {
  if (!storage || !key) return [];
  try {
    const raw: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is [string, T] =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string',
    );
  } catch {
    return [];
  }
}

/** Места в лентах: есть запись — разговор листали и при возврате вернём туда же. */
export const feedPositions = createFeedMemory<FeedSnapshot>(FEED_MEMORY_LIMIT, {
  key: 'agentdeck:feed-positions',
});

/**
 * Размер окна ленты («Загрузить ещё»). Без него возврат к месту в ранней части
 * длинного разговора не сработал бы: окно при смене разговора сбрасывается к
 * последним сообщениям, и якоря в нём просто нет.
 */
const feedLimits = createFeedMemory<number>(FEED_MEMORY_LIMIT, { key: 'agentdeck:feed-limits' });

/** Запомнить окно разговора после «Загрузить ещё». */
export function rememberFeedLimit(chatId: string | undefined, limit: number): void {
  if (chatId) feedLimits.set(chatId, limit);
}

/**
 * Окно разговора при возврате. Только для разговора, место в котором помним:
 * стоял у низа — открываем как раньше, последним окном, а не тянем лишние
 * сотни сообщений ради места, которого нет.
 */
export function recallFeedLimit(chatId: string | undefined): number | undefined {
  if (!chatId || !feedPositions.get(chatId)) return undefined;
  return feedLimits.get(chatId);
}

/** Стоит ли лента у низа — тогда её место не запоминается, она едет за ответом. */
export function isPinnedAt(list: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < PINNED_THRESHOLD;
}

/**
 * Якорь — первое сообщение, чей низ виден в ленте. Все сообщения выше видимой
 * части (человек долистал до сводки групп под ними) — якорем служит последнее,
 * со сдвигом меньше нуля: так место под лентой переживает и новые сообщения.
 */
export function pickAnchor(rows: readonly FeedRow[]): FeedAnchor | undefined {
  const row = rows.find((candidate) => candidate.bottom > 0) ?? rows.at(-1);
  return row ? { id: row.id, offset: row.top } : undefined;
}

/** Снимок места по нарисованным сообщениям. */
export function snapshotOf(rows: readonly FeedRow[], scrollTop: number): FeedSnapshot {
  const anchor = pickAnchor(rows);
  const lastId = rows.at(-1)?.id;
  return { scrollTop, ...(anchor ? { anchor } : {}), ...(lastId ? { lastId } : {}) };
}

/**
 * Куда вернуть прокрутку. `undefined` — ещё рано: на экране не та переписка
 * (её ещё грузят, а пока показано окно прошлого разговора) — ждём следующей
 * отрисовки, а не ставим ленту по чужим сообщениям.
 *
 * Якорь нарисован — двигаем ленту так, чтобы он встал на прежний сдвиг. Якоря
 * нет, но последнее сообщение снимка на месте (переписка та же, якорь выпал из
 * окна) — возвращаем сырую прокрутку: это лучше, чем бросить человека вниз.
 */
export function restoreTarget(snapshot: FeedSnapshot, probe: FeedProbe): number | undefined {
  const clamp = (value: number) => Math.min(Math.max(value, 0), Math.max(probe.maxScroll, 0));
  if (snapshot.anchor && probe.anchorTop !== undefined) {
    return clamp(probe.scrollTop + probe.anchorTop - snapshot.anchor.offset);
  }
  if (probe.hasLast) return clamp(snapshot.scrollTop);
  return undefined;
}
