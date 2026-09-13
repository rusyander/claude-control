import type { Deck, DeckSlide, DeckSource } from '@agentdeck/contracts';
import {
  DECK_MAX_BULLETS,
  DECK_MAX_COLUMNS,
  DECK_MAX_SOURCES,
  DECK_MAX_STATS,
} from '@agentdeck/contracts/media-deck';
import type { DeckAssets } from './assets.ts';
import { deckLine, deckLines, hasText } from './text.ts';

/**
 * Что слайд ПОКАЗЫВАЕТ — один раз на оба отрисовщика.
 *
 * Решений здесь два рода, и оба обязаны совпасть в HTML и в PPTX. Первое:
 * раскладка, которой нечего показать, не рисуется — модель назвала `stats`, а
 * чисел не прислала, значит слайд уходит в пункты, а не остаётся пустым листом с
 * одним заголовком. Второе: крупность — два пункта на слайде набираются крупно,
 * двенадцать мелко, а самое длинное число задаёт кегль всему ряду.
 *
 * Если бы это лежало в каждом отрисовщике по разу, колода на экране и колода на
 * флешке разъехались бы уже на втором таком правиле, и увидел бы это человек
 * перед залом.
 */

export type SlideLayout =
  'bullets' | 'statement' | 'stats' | 'columns' | 'quote' | 'section' | 'figure';

/** Три ступени кегля. Что именно они значат, решает формат. */
export type SizeStep = 'big' | 'mid' | 'small';

/** Плотность списка: два пункта и двенадцать — это разные слайды. */
export type ListTier = 'airy' | 'normal' | 'dense';

export interface PlannedStat {
  value: string;
  label: string;
}

export interface PlannedColumn {
  title: string;
  bullets: string[];
}

export interface PlannedQuote {
  text: string;
  author: string;
}

export interface SlidePlan {
  layout: SlideLayout;
  title: string;
  bullets: string[];
  tier: ListTier;
  stats: PlannedStat[];
  statSize: SizeStep;
  statementSize: SizeStep;
  columns: PlannedColumn[];
  quote?: PlannedQuote;
  /** Схема кодом, уже проверенная; пусто — рисовать нечего. */
  figure?: string;
  /** Растровая картинка `data:`-адресом. */
  picture?: string;
  caption: string;
  sources: DeckSource[];
  notes: string;
}

/** Разбор одного слайда: после него отрисовщику остаётся только расставить. */
export function planSlide(slide: DeckSlide, assets: DeckAssets): SlidePlan {
  const title = deckLine(slide?.title);
  const bullets = deckLines(slide?.bullets).slice(0, DECK_MAX_BULLETS);
  const stats = planStats(slide);
  const columns = planColumns(slide);
  const quote = planQuote(slide);
  const figure = planFigure(slide);
  const picture = planPicture(slide, assets);
  const widest = stats.reduce((max, stat) => Math.max(max, stat.value.length), 0);
  const length = bullets.join(' ').length;
  const dense = bullets.length > 6 || length > 320;

  return {
    layout: chooseLayout(slide, { stats, columns, quote, figure, picture, bullets }),
    title,
    bullets,
    tier: dense ? 'dense' : bullets.length <= 3 && length <= 150 ? 'airy' : 'normal',
    stats,
    statSize: step(widest, 3, 6),
    statementSize: step(title.length, 48, 90),
    columns,
    quote,
    figure,
    picture,
    caption: deckLine(slide?.figureCaption),
    sources: planSources(slide?.sources),
    notes: deckLine(slide?.notes),
  };
}

/** Колода целиком: обложка и общий список источников. */
export interface DeckPlan {
  title: string;
  subtitle: string;
  /** Подзаголовок короткий — он становится надстрочной строкой над названием. */
  subtitleAbove: boolean;
  titleSize: SizeStep;
  sources: DeckSource[];
  slides: DeckSlide[];
}

export function planDeck(deck: Deck): DeckPlan {
  const title = deckLine(deck?.title);
  const subtitle = deckLine(deck?.subtitle);
  return {
    title,
    subtitle,
    subtitleAbove: subtitle.length > 0 && subtitle.length <= 60,
    titleSize: title.length > 44 ? 'mid' : 'big',
    sources: planSources(deck?.sources),
    slides: Array.isArray(deck?.slides) ? deck.slides : [],
  };
}

function step(length: number, big: number, mid: number): SizeStep {
  if (length > mid) return 'small';
  return length > big ? 'mid' : 'big';
}

interface Parts {
  stats: PlannedStat[];
  columns: PlannedColumn[];
  quote?: PlannedQuote;
  figure?: string;
  picture?: string;
  bullets: string[];
}

function chooseLayout(slide: DeckSlide, parts: Parts): SlideLayout {
  const want = (slide?.layout ?? 'bullets') as SlideLayout;
  const empty =
    (want === 'stats' && parts.stats.length === 0) ||
    (want === 'columns' && parts.columns.length === 0) ||
    (want === 'quote' && !parts.quote) ||
    (want === 'figure' && !parts.figure && !parts.picture);
  if (!empty && want !== 'bullets') return want;
  if (parts.bullets.length === 0 && !parts.figure && !parts.picture) return 'statement';
  return 'bullets';
}

function planStats(slide: DeckSlide): PlannedStat[] {
  return (slide?.stats ?? [])
    .filter((stat) => hasText(stat?.value))
    .slice(0, DECK_MAX_STATS)
    .map((stat) => ({ value: deckLine(stat.value), label: deckLine(stat.label) }));
}

function planColumns(slide: DeckSlide): PlannedColumn[] {
  return (slide?.columns ?? [])
    .map((column) => ({
      title: deckLine(column?.title),
      bullets: deckLines(column?.bullets).slice(0, DECK_MAX_BULLETS),
    }))
    .filter((column) => column.title.length > 0 || column.bullets.length > 0)
    .slice(0, DECK_MAX_COLUMNS);
}

function planQuote(slide: DeckSlide): PlannedQuote | undefined {
  const text = deckLine(slide?.quote?.text);
  if (!text) return undefined;
  return { text, author: deckLine(slide?.quote?.author) };
}

/**
 * Схема приходит проверенной разбором картинок, но корнем её обязан быть `svg`:
 * всё прочее в этом поле — не схема, и на слайде ему делать нечего.
 */
function planFigure(slide: DeckSlide): string | undefined {
  const figure = deckLine(slide?.figure);
  return figure.startsWith('<svg') ? figure : undefined;
}

function planPicture(slide: DeckSlide, assets: DeckAssets): string | undefined {
  if (!slide?.pictureId) return undefined;
  const uri = assets.picture(slide.pictureId);
  return uri && uri.startsWith('data:') ? uri : undefined;
}

function planSources(sources: DeckSource[] | undefined): DeckSource[] {
  return (Array.isArray(sources) ? sources : [])
    .map((source) => ({ title: deckLine(source?.title), url: deckLine(source?.url) }))
    .filter((source) => source.title.length > 0 || source.url.length > 0)
    .slice(0, DECK_MAX_SOURCES);
}
