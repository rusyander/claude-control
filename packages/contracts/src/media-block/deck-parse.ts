import type {
  Deck,
  DeckColumn,
  DeckLayout,
  DeckQuote,
  DeckSlide,
  DeckSource,
  DeckStat,
} from '../media-deck-model.ts';
import {
  DECK_MAX_BULLET,
  DECK_MAX_BULLETS,
  DECK_MAX_COLUMNS,
  DECK_MAX_FIGURE_CHARS,
  DECK_MAX_ILLUSTRATION,
  DECK_MAX_NOTES,
  DECK_MAX_QUOTE,
  DECK_MAX_SLIDES,
  DECK_MAX_SOURCES,
  DECK_MAX_STAT_VALUE,
  DECK_MAX_STATS,
  DECK_MAX_TITLE,
  DECK_MAX_URL,
  deckAccents,
  deckLayouts,
  deckPresets,
} from '../media-deck-model.ts';
import { checkPicture } from './picture.ts';
import { blockLang } from '../brand.ts';

/**
 * Колода из тела блока: ручная проверка вместо схемы — те же правила нужны и на
 * разборе ответа модели, и на приёме запроса от карточки, а два понимания формата
 * разошлись бы.
 */

/** Язык блока с колодой. Он же признак, по которому панель узнаёт предложение. */
export const DECK_BLOCK_LANG = blockLang('deck');

/** Что панель поняла в блоке. */
export interface DeckParse {
  /** Колода, годная к сборке. Пусто — в блоке не колода. */
  deck?: Deck;
  /**
   * Панель что-то ОБРЕЗАЛА по своим потолкам: слайдов, пунктов или знаков в
   * строке было больше, чем она берёт.
   *
   * Признак нужен не для порядка: агент, надиктовавший тридцать слайдов из
   * пятидесяти запрошенных, выглядел бы просто небрежным, а ошибка была бы
   * панелью. Молчаливое обрезание — то же самое, что молчаливый отказ.
   */
  truncated: boolean;
}

/** Счётчик обрезаний — общий на весь разбор одного блока. */
interface Cut {
  hit: boolean;
}

/**
 * Колода из тела блока.
 *
 * Лишние поля игнорируются, недостающие заполняются пустотой, а вот колода без
 * заголовка или без единого слайда — не колода: карточка показала бы пустой
 * файл, в котором нечего смотреть.
 */
export function parseDeckBlock(body: string): DeckParse {
  const cut: Cut = { hit: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(body));
  } catch {
    return { truncated: false };
  }
  if (!isRecord(parsed)) return { truncated: false };

  const title = text(parsed.title, DECK_MAX_TITLE, cut);
  const rows = Array.isArray(parsed.slides) ? parsed.slides : [];
  if (rows.length > DECK_MAX_SLIDES) cut.hit = true;
  const slides: DeckSlide[] = [];

  for (const row of rows.slice(0, DECK_MAX_SLIDES)) {
    if (!isRecord(row)) continue;
    const slide = parseSlide(row, cut);
    if (slide) slides.push(slide);
  }

  if (!title || slides.length === 0) return { truncated: false };
  return {
    deck: {
      title,
      subtitle: text(parsed.subtitle, DECK_MAX_TITLE, cut),
      slides,
      ...pick('accent', oneOf(parsed.accent, deckAccents)),
      ...pick('preset', oneOf(parsed.preset, deckPresets)),
      ...pick('sources', sources(parsed.sources, cut)),
    },
    truncated: cut.hit,
  };
}

/**
 * Один слайд. Всё, кроме заголовка, пунктов и заметки, — необязательно, и
 * НЕОПОЗНАННОЕ выбрасывается молча: колода, где модель придумала свою раскладку
 * или свой цвет, обязана остаться колодой, а не отказом. Пустой слайд (нет ни
 * заголовка, ни единого наполнения) не берём — в файле он был бы белым листом.
 */
function parseSlide(row: Record<string, unknown>, cut: Cut): DeckSlide | undefined {
  const bullets = list(row.bullets, DECK_MAX_BULLETS, DECK_MAX_BULLET, cut);
  const slideTitle = text(row.title, DECK_MAX_TITLE, cut);
  const stats = statList(row.stats, cut);
  const columns = columnList(row.columns, cut);
  const quote = quoteOf(row.quote, cut);
  // Схему проверяем ТЕМ ЖЕ разбором, что рисунок режима: скрипт или ссылка наружу
  // внутри слайда опаснее, чем в отдельном файле, — страницу колоды открывают не
  // задумываясь.
  const figure = ((): string | undefined => {
    const raw = text(row.figure, DECK_MAX_FIGURE_CHARS, cut);
    if (!raw) return undefined;
    return checkPicture(raw).svg;
  })();

  const filled =
    Boolean(slideTitle) ||
    bullets.length > 0 ||
    stats.length > 0 ||
    columns.length > 0 ||
    Boolean(quote) ||
    Boolean(figure);
  if (!filled) return undefined;

  return {
    title: slideTitle,
    bullets,
    notes: text(row.notes, DECK_MAX_NOTES, cut),
    ...pick('layout', oneOf(row.layout, deckLayouts) as DeckLayout | undefined),
    ...(stats.length > 0 ? { stats } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    ...pick('quote', quote),
    ...pick('figure', figure),
    ...pick('figureCaption', text(row.figureCaption, DECK_MAX_TITLE, cut) || undefined),
    ...pick('illustration', text(row.illustration, DECK_MAX_ILLUSTRATION, cut) || undefined),
    // Идентификатор нарисованной картинки приходит обратно при правке — своим же
    // именем файла. Здесь только форма; ЧУЖОЙ идентификатор отсекает панель,
    // сверяя его с прошлым набором колоды (`presentations.ts → keepPictures`).
    ...pick('pictureId', pictureId(row.pictureId)),
    ...pick('sources', sources(row.sources, cut)),
  };
}

/** Поле, которого может не быть: `exactOptionalPropertyTypes` не терпит `undefined`. */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Имя файла картинки в хранилище панели. Форма та же, что у `assertId` на
 * сервере: только шестнадцатеричные знаки, поэтому ни путём, ни адресом это
 * значение стать не может.
 */
function pictureId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{16,32}$/.test(value.trim())
    ? value.trim()
    : undefined;
}

/** Значение из закрытого списка. Чужое — как будто его не сказали. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function list(value: unknown, max: number, maxChars: number, cut: Cut): string[] {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > max) cut.hit = true;
  return rows
    .slice(0, max)
    .map((item) => text(item, maxChars, cut))
    .filter((item) => item.length > 0);
}

function statList(value: unknown, cut: Cut): DeckStat[] {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > DECK_MAX_STATS) cut.hit = true;
  const stats: DeckStat[] = [];
  for (const row of rows.slice(0, DECK_MAX_STATS)) {
    if (!isRecord(row)) continue;
    const stat = text(row.value, DECK_MAX_STAT_VALUE, cut);
    // Число без подписи — загадка на слайде, подпись без числа — просто строка.
    const label = text(row.label, DECK_MAX_BULLET, cut);
    if (stat && label) stats.push({ value: stat, label });
  }
  return stats;
}

function columnList(value: unknown, cut: Cut): DeckColumn[] {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > DECK_MAX_COLUMNS) cut.hit = true;
  const columns: DeckColumn[] = [];
  for (const row of rows.slice(0, DECK_MAX_COLUMNS)) {
    if (!isRecord(row)) continue;
    const bullets = list(row.bullets, DECK_MAX_BULLETS, DECK_MAX_BULLET, cut);
    const columnTitle = text(row.title, DECK_MAX_TITLE, cut);
    if (columnTitle || bullets.length > 0) columns.push({ title: columnTitle, bullets });
  }
  // Одна колонка — это не сравнение: такой слайд рисуется обычными пунктами.
  return columns.length >= 2 ? columns : [];
}

function quoteOf(value: unknown, cut: Cut): DeckQuote | undefined {
  if (!isRecord(value)) return undefined;
  const quote = text(value.text, DECK_MAX_QUOTE, cut);
  if (!quote) return undefined;
  return { text: quote, author: text(value.author, DECK_MAX_TITLE, cut) };
}

/**
 * Источники. Адрес остаётся текстом, но `javascript:` и `data:` в нём не нужны
 * даже текстом: показанный адрес человек копирует и открывает руками.
 */
function sources(value: unknown, cut: Cut): DeckSource[] | undefined {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > DECK_MAX_SOURCES) cut.hit = true;
  const found: DeckSource[] = [];
  for (const row of rows.slice(0, DECK_MAX_SOURCES)) {
    if (!isRecord(row)) continue;
    const sourceTitle = text(row.title, DECK_MAX_TITLE, cut);
    const url = text(row.url, DECK_MAX_URL, cut);
    const safe = /^https?:\/\//i.test(url) ? url : '';
    if (sourceTitle || safe) found.push({ title: sourceTitle, url: safe });
  }
  return found.length > 0 ? found : undefined;
}

/**
 * Тело блока бывает завёрнуто ещё раз — разворачиваем один слой.
 *
 * Язык забора берём с двоеточием и точкой НАМЕРЕННО: так пишется наш собственный
 * `agentdeck:deck`, и модель контура, которой правила колоды приехали
 * системным сообщением, отвечает именно им — а не голым JSON, как её просили.
 * Пока класс символов был `[a-z-]`, такой ответ панель объявляла «не колодой»,
 * хотя колода в нём была (поймано живым прогоном по проводу 13.09.2026).
 */
function stripFence(body: string): string {
  const trimmed = body.trim();
  const fenced = /^(?:`{3,}|~{3,})[a-z0-9:._-]*[ \t]*\r?\n([\s\S]*?)\r?\n?(?:`{3,}|~{3,})$/i.exec(
    trimmed,
  );
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * Знаки, которых не бывает в XML 1.0, — управляющие (кроме табуляции и переводов
 * строки), два непарных кода и одинокие половины пары.
 *
 * Убираются они ЗДЕСЬ, на единственной границе доверия, а не в отрисовщике:
 * `pptxgenjs` экранирует `& < > " '` и ничего больше, поэтому такой знак уезжал
 * прямо в `ppt/slides/slide2.xml` — настоящий PowerPoint открывал файл и МОЛЧА
 * обрезал пункт на этом месте, а строгий разбор (`System.Xml`, libxml2,
 * LibreOffice) отказывался от части целиком. Поймано враждебной проверкой
 * 13.09.2026 на живом файле; собственная защита отрисовщика PPTX стоит второй.
 */
const ILLEGAL_XML =
  // eslint-disable-next-line no-control-regex -- запрещённые в XML знаки перечислены кодами
  /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/g;

function text(value: unknown, max: number, cut: Cut): string {
  if (typeof value !== 'string') return '';
  // Пара половин — это обычный знак (эмодзи), её сохраняем; одинокая половина
  // ломает и XML, и JSON на обратном пути в модель при правке.
  const clean = value.replace(ILLEGAL_XML, (_match, pair: string | undefined) => pair ?? ' ');
  const trimmed = clean.trim();
  if (trimmed.length > max) cut.hit = true;
  return trimmed.slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
