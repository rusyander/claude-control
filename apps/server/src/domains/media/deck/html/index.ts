import type { Deck } from '@agentdeck/contracts';
import { type DeckAssets, NO_ASSETS } from '../assets.ts';
import { planDeck, planSlide } from '../plan.ts';
import { deckPalette } from '../theme.ts';
import { escapeHtml, paragraphs } from './markup.ts';
import { coverMarkup, type SlideCtx, slideMarkup, sourcesMarkup } from './slides.ts';
import { deckStyles } from './styles.ts';

/**
 * Колода → одна HTML-страница.
 *
 * Страница СОБИРАЕТСЯ ЗДЕСЬ, а не приходит от модели, и пять требований в ней
 * держатся именно поэтому:
 *
 *  1. НИ ОДНОГО обращения в сеть и ни одного скрипта. Ни шрифта из Google Fonts,
 *     ни стилей с CDN, ни картинки по ссылке: страница открывается в песочнице
 *     `iframe` с `default-src 'none'`, и всё внешнее там всё равно не загрузится
 *     — молча. Строка с CDN в колоде выглядела бы как «у человека плохой
 *     интернет». Поэтому и движение на странице сделано только стилями:
 *     прокрутка с примагничиванием и появление по `animation-timeline: view()`.
 *  2. Ни одного знака из ответа модели не попадает в разметку без экранирования:
 *     текст слайдов — чужой ввод, и `<script>` в заголовке обязан остаться
 *     текстом заголовка. Исключение ровно одно — схема (`figure`), она приходит
 *     проверенной тем же разбором, что рисунок режима «Картинка кодом», и стоит
 *     в рамке с ограниченным размером.
 *  3. Печать — тем же файлом. Размер страницы объявлен `@page` (13.333in ×
 *     7.5in — 16:9), поэтому PDF получается ровно из этой страницы, а не из её
 *     «примерного вида»: браузер печатает то, что видно.
 *  4. Заметки докладчику — ПОД слайдом, в свёрнутом блоке, и в печать не идут.
 *     На лице слайда им места нет: их видит зал.
 *  5. Колода нарисована светлой и не перекрашивается тёмной темой браузера:
 *     `only light` снимает встроенное затемнение Chrome/Edge, `darkreader-lock`
 *     — расширение Dark Reader. Без них Dark Reader делал из светлого слайда
 *     «металл» с серым текстом, которого не прочесть (живой прогон 25.09.2026).
 *
 * Второй довод необязателен: колода с диска и все прежние колоды приходят без
 * картинок, и страница обязана собраться без них.
 */
export function renderDeckHtml(deck: Deck, assets: DeckAssets = NO_ASSETS): string {
  const plan = planDeck(deck);
  const total = plan.slides.length + (plan.sources.length > 0 ? 1 : 0);
  const context = (index: number): SlideCtx => ({ index, total, deckTitle: plan.title });

  const items = plan.slides.map((slide, at) => {
    const slidePlan = planSlide(slide, assets);
    return item(slideMarkup(slidePlan, context(at + 1)), slidePlan.notes);
  });
  if (plan.sources.length > 0) {
    items.push(item(sourcesMarkup(plan.sources, context(total)), ''));
  }

  return [
    '<!doctype html>',
    `<html lang="ru" data-accent="${escapeHtml(deck?.accent ?? 'indigo')}">`,
    '<head>',
    '<meta charset="utf-8">',
    DECK_THEME_LOCK,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(plan.title || 'Презентация')}</title>`,
    `<style>${deckStyles(deckPalette(deck?.accent))}</style>`,
    '</head>',
    '<body>',
    item(coverMarkup(plan, plan.slides.length), ''),
    ...items,
    '</body>',
    '</html>',
  ].join('\n');
}

/** Слайд и его заметки — одним блоком: в печати блок и есть страница. */
function item(slide: string, notes: string): string {
  const text = paragraphs(notes);
  const details = text
    ? '<details class="notes"><summary>Докладчику</summary>' +
      `<div class="notes__text">${text}</div></details>`
    : '';
  return `<article class="item">${slide}${details}</article>`;
}

/** Замок светлой темы (довод 5 у `renderDeckHtml`). */
const DECK_THEME_LOCK =
  '<meta name="color-scheme" content="only light">\n<meta name="darkreader-lock">';

/**
 * Колода, собранная до замка, получает его при отдаче: файлы на диске не
 * пересобираются, а смотрят их тем же браузером с тем же Dark Reader.
 */
export function lockDeckTheme(html: string): string {
  if (html.includes('name="darkreader-lock"')) return html;
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${DECK_THEME_LOCK}`);
}
