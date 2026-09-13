import type { Deck } from '@agentdeck/contracts';
import PptxGenJS from 'pptxgenjs';
import { type DeckAssets, NO_ASSETS } from '../assets.ts';
import { planDeck, planSlide } from '../plan.ts';
import { DECK_H_IN, DECK_W_IN, deckPalette } from '../theme.ts';
import { inkFor } from './layout.ts';
import { drawCover, drawSlide, drawSources } from './slides.ts';

/**
 * Колода → файл PowerPoint.
 *
 * ПОЧЕМУ ЗДЕСЬ ЗАВИСИМОСТЬ, когда zip панель пишет сама (`lib/zip.ts`). Zip —
 * контейнер: его формат описан на двух страницах, и проверяется он собственным
 * разбором. PPTX — строгий документ OOXML: PowerPoint отказывается открывать
 * файл с неверным порядком частей или отсутствующим мастером заметок, и сообщает
 * об этом словом «восстановить», из которого не следует ничего. Собственная
 * сборка XML означала бы формат, который я не могу проверить у человека на
 * машине, а битая колода — это отказ ровно в тот момент, когда её открывают
 * перед людьми. Отсюда `pptxgenjs`: сборку OOXML держит он, а панель отвечает за
 * содержание.
 *
 * Проверяется это НЕ разбором: `.agent/tmp/t10-pptx-inspect.ps1` открывает
 * собранный файл настоящим PowerPoint через COM и отвечает числом слайдов, их
 * фигурами и текстом заметки. Единственное доказательство, которое нельзя
 * подделать разбором zip-а — им же проверено, что схема доезжает картинкой
 * (PowerPoint видит её как графику, тип 28), а не пропадает молча.
 *
 * Второй довод необязателен: колода с диска приходит без картинок, и файл
 * обязан собраться без них.
 */
export async function renderDeckPptx(deck: Deck, assets: DeckAssets = NO_ASSETS): Promise<Buffer> {
  const plan = planDeck(deck);
  const ink = inkFor(deckPalette(deck?.accent));

  const pptx = new PptxGenJS();
  // Своя раскладка: 13.333 × 7.5 дюйма — 16:9, ровно как @page на странице.
  pptx.defineLayout({ name: 'CC16x9', width: DECK_W_IN, height: DECK_H_IN });
  pptx.layout = 'CC16x9';
  pptx.title = plan.title;
  // Автор — панель, а не человек: файл собран ею, и подписывать им чужое имя
  // означало бы приписать человеку текст, который надиктовала модель.
  pptx.author = 'agentdeck';

  const total = plan.slides.length + (plan.sources.length > 0 ? 1 : 0);
  drawCover(pptx, pptx.addSlide(), plan, plan.slides.length, ink);
  plan.slides.forEach((slide, at) => {
    const ctx = { index: at + 1, total, deckTitle: plan.title };
    drawSlide(pptx, pptx.addSlide(), planSlide(slide, assets), ctx, ink);
  });
  if (plan.sources.length > 0) {
    drawSources(
      pptx,
      pptx.addSlide(),
      plan.sources,
      { index: total, total, deckTitle: plan.title },
      ink,
    );
  }

  const written = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(written) ? written : Buffer.from(written as ArrayBuffer);
}
