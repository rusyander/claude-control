import type { DeckSource } from '@agentdeck/contracts';
import type { DeckPlan, SlidePlan } from '../plan.ts';
import { esc, escapeHtml, ordinal, stagger } from './markup.ts';

/**
 * Раскладки слайда в разметке. Что именно слайд показывает, решено раньше —
 * в `plan.ts`, одинаково для страницы и для PowerPoint; здесь только укладка.
 */

/** Что известно слайду о колоде: без этого он не нарисует нижнюю планку. */
export interface SlideCtx {
  /** Номер слайда среди содержательных, с единицы. Обложка не в счёт. */
  index: number;
  /** Сколько их всего — вместе со слайдом источников. */
  total: number;
  /** Название колоды: оно стоит на планке каждого слайда. */
  deckTitle: string;
}

/** Слайд целиком: `<section>` со всем содержимым. */
export function slideMarkup(plan: SlidePlan, ctx: SlideCtx): string {
  const deep = plan.layout === 'section';
  const bare = plan.layout === 'statement' || plan.layout === 'section';
  return [
    `<section class="slide ${deep ? 'slide--deep' : 'slide--paper'} slide--${plan.layout}">`,
    deep ? `<span class="section__ghost">${ordinal(ctx.index)}</span>` : '',
    bare ? '' : slideHead(plan),
    layoutBody(plan),
    citeList(plan.sources),
    slideFoot(ctx),
    '</section>',
  ].join('');
}

/** Обложка: единственный слайд без планки и без номера. */
export function coverMarkup(deck: DeckPlan, slideCount: number): string {
  const long = deck.titleSize !== 'big';
  return [
    '<section class="slide slide--deep slide--cover">',
    deck.subtitleAbove
      ? `<div class="cover__kicker"><i></i>${escapeHtml(deck.subtitle)}</div>`
      : '',
    deck.title
      ? `<h1 class="cover__title${long ? ' cover__title--long' : ''}">${escapeHtml(deck.title)}</h1>`
      : '',
    !deck.subtitleAbove && deck.subtitle
      ? `<p class="cover__sub">${escapeHtml(deck.subtitle)}</p>`
      : '',
    '<div class="cover__rule"></div>',
    slideCount > 0 ? `<div class="cover__count">${ordinal(slideCount)}</div>` : '',
    '</section>',
  ].join('');
}

/** Слайд источников колоды — последний. */
export function sourcesMarkup(sources: DeckSource[], ctx: SlideCtx): string {
  const items = sources
    .map(
      (source, at) =>
        `<li${stagger(at)}><span class="srcs__title">${esc(source.title)}</span>` +
        `<span class="srcs__url">${esc(source.url)}</span></li>`,
    )
    .join('');
  return [
    '<section class="slide slide--paper slide--sources">',
    '<header class="head"><div class="rule"></div><h2 class="title">Источники</h2></header>',
    `<div class="body${sources.length > 6 ? ' body--top' : ''}">` +
      `<ol class="srcs${sources.length < 5 ? ' srcs--one' : ''}">${items}</ol></div>`,
    slideFoot(ctx),
    '</section>',
  ].join('');
}

/** Заголовок слайда. У схемы и цитаты он мельче: там главное — не он. */
function slideHead(plan: SlidePlan): string {
  if (!plan.title) return '';
  const small = plan.layout === 'figure' || plan.layout === 'quote';
  return [
    '<header class="head">',
    '<div class="rule"></div>',
    `<h2 class="title${small ? ' title--small' : ''}">${escapeHtml(plan.title)}</h2>`,
    '</header>',
  ].join('');
}

/** Нижняя планка: название колоды, полоса хода и номер. */
function slideFoot(ctx: SlideCtx): string {
  const done = Math.round((ctx.index / Math.max(ctx.total, 1)) * 100);
  return [
    '<footer class="foot">',
    `<span class="foot__name">${escapeHtml(ctx.deckTitle)}</span>`,
    `<span class="foot__bar"><i style="width:${done}%"></i></span>`,
    `<span class="foot__num">${ctx.index} / ${ctx.total}</span>`,
    '</footer>',
  ].join('');
}

/** Сноски слайда. Пусто — ничего не рисуем: пустая полоса выглядит как обрезка. */
function citeList(sources: DeckSource[]): string {
  if (sources.length === 0) return '';
  const items = sources
    .map((source) => {
      const title = source.title ? `<b>${escapeHtml(source.title)}</b>` : '';
      const url = source.url ? ` ${escapeHtml(source.url)}` : '';
      return `<li>${title}${url}</li>`;
    })
    .join('');
  return `<ul class="cites">${items}</ul>`;
}

function layoutBody(plan: SlidePlan): string {
  switch (plan.layout) {
    case 'section':
      return sectionBody(plan);
    case 'statement':
      return statementBody(plan);
    case 'stats':
      return statsBody(plan);
    case 'columns':
      return columnsBody(plan);
    case 'quote':
      return quoteBody(plan);
    case 'figure':
      return figureBody(plan);
    default:
      return bulletsBody(plan);
  }
}

function sectionBody(plan: SlidePlan): string {
  const lede = plan.bullets[0];
  return [
    '<div class="body">',
    '<div class="rule"></div>',
    `<h2 class="section__title">${escapeHtml(plan.title)}</h2>`,
    lede ? `<p class="section__lede"${stagger(1)}>${escapeHtml(lede)}</p>` : '',
    '</div>',
  ].join('');
}

function statementBody(plan: SlidePlan): string {
  const size =
    plan.statementSize === 'small'
      ? ' statement__text--long'
      : plan.statementSize === 'mid'
        ? ' statement__text--mid'
        : '';
  const note = plan.bullets[0];
  return [
    '<div class="body">',
    '<div class="rule"></div>',
    `<p class="statement__text${size}">${escapeHtml(plan.title)}</p>`,
    note ? `<p class="statement__note"${stagger(1)}>${escapeHtml(note)}</p>` : '',
    '</div>',
  ].join('');
}

function statsBody(plan: SlidePlan): string {
  const size =
    plan.statSize === 'small'
      ? ' stat__value--long'
      : plan.statSize === 'mid'
        ? ' stat__value--mid'
        : '';
  const row = plan.stats
    .map((stat, at) =>
      [
        `<div class="stat"${stagger(at)}>`,
        `<div class="stat__value${size}">${escapeHtml(stat.value)}</div>`,
        `<div class="stat__label">${escapeHtml(stat.label)}</div>`,
        '</div>',
      ].join(''),
    )
    .join('');
  const after = plan.bullets
    .slice(0, 3)
    .map((line, at) => `<li${stagger(at)}>${escapeHtml(line)}</li>`)
    .join('');
  return [
    '<div class="body">',
    `<div class="stats">${row}</div>`,
    after ? `<ul class="stats__after">${after}</ul>` : '',
    '</div>',
  ].join('');
}

function columnsBody(plan: SlidePlan): string {
  const panels = plan.columns
    .map((column, at) => {
      const lines = column.bullets
        .map((line, i) => `<li${stagger(i)}>${escapeHtml(line)}</li>`)
        .join('');
      return [
        `<section class="col${at === 1 ? ' col--accent' : ''}"${stagger(at)}>`,
        column.title ? `<h3 class="col__title">${escapeHtml(column.title)}</h3>` : '',
        lines ? `<ul>${lines}</ul>` : '',
        '</section>',
      ].join('');
    })
    .join('');
  return `<div class="body"><div class="cols">${panels}</div></div>`;
}

function quoteBody(plan: SlidePlan): string {
  return [
    '<div class="body">',
    '<figure class="quote">',
    '<span class="quote__mark">&#8220;</span>',
    `<blockquote class="quote__text">${escapeHtml(plan.quote?.text ?? '')}</blockquote>`,
    plan.quote?.author
      ? `<figcaption class="quote__author">&#8212; ${escapeHtml(plan.quote.author)}</figcaption>`
      : '',
    '</figure>',
    '</div>',
  ].join('');
}

function figureBody(plan: SlidePlan): string {
  return [
    '<div class="body body--top">',
    plan.figure ? `<div class="fig">${plan.figure}</div>` : '',
    plan.picture && !plan.figure ? pictureBlock(plan.picture, plan.title) : '',
    plan.caption ? `<p class="fig__cap">${escapeHtml(plan.caption)}</p>` : '',
    '</div>',
  ].join('');
}

function bulletsBody(plan: SlidePlan): string {
  const tier = plan.tier === 'dense' ? ' list--dense' : plan.tier === 'airy' ? ' list--airy' : '';
  const list = plan.bullets.length
    ? `<ul class="list${tier}">${plan.bullets
        .map((line, at) => `<li${stagger(at)}>${escapeHtml(line)}</li>`)
        .join('')}</ul>`
    : '';
  if (!plan.picture && !plan.figure) return `<div class="body">${list}</div>`;
  const side = [
    plan.picture ? pictureBlock(plan.picture, plan.title) : '',
    plan.figure ? `<div class="fig">${plan.figure}</div>` : '',
  ].join('');
  return [
    '<div class="body">',
    '<div class="split">',
    `<div class="split__text">${list}</div>`,
    `<div class="split__media"${stagger(1)}>${side}</div>`,
    '</div>',
    '</div>',
  ].join('');
}

/** Растровая картинка — байтами внутри страницы, `alt` из заголовка слайда. */
function pictureBlock(uri: string, title: string): string {
  return `<div class="shot"><img src="${escapeHtml(uri)}" alt="${esc(title)}"></div>`;
}
