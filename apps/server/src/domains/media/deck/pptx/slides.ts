import type PptxGenJS from 'pptxgenjs';
import type { DeckSource } from '@agentdeck/contracts';
import type { DeckPlan, SlidePlan } from '../plan.ts';
import { mix } from '../theme.ts';
import {
  BODY_BOTTOM,
  BODY_Y,
  CITES_Y,
  CONTENT_W,
  FONT,
  type Ink,
  MX,
  type Page,
  PT,
  SLIDE_H,
  SLIDE_W,
  TITLE_Y,
  deepBackground,
  footer,
  ghostColor,
  paperBackground,
  ruleShape,
} from './layout.ts';

/**
 * Раскладки слайда в PowerPoint. Решение, ЧТО показывать, принято в `plan.ts` —
 * одно на оба отрисовщика; здесь только расстановка по дюймам.
 *
 * Градиентной заливки у pptxgenjs нет, поэтому глубина фона набрана фигурами с
 * прозрачностью, а «полупрозрачный» текст (призрачный номер, кавычка) —
 * посчитанной смесью цветов: в OOXML прозрачность текста живёт не везде, а
 * смешанный цвет выглядит одинаково в любой версии.
 */

/** Номер слайда в колоде — для нижней планки. */
export interface PageCtx {
  index: number;
  total: number;
  deckTitle: string;
}

export function drawCover(
  pptx: PptxGenJS,
  page: Page,
  deck: DeckPlan,
  slideCount: number,
  ink: Ink,
): void {
  deepBackground(page, pptx, ink);
  if (deck.subtitleAbove) {
    page.addText(deck.subtitle.toUpperCase(), {
      x: MX,
      y: 2.28,
      w: CONTENT_W,
      h: 0.36,
      fontFace: FONT,
      fontSize: PT.eyebrow,
      bold: true,
      charSpacing: 2,
      color: ink.palette.accentBright,
      valign: 'middle',
    });
  }
  if (deck.title) {
    page.addText(deck.title, {
      x: MX,
      y: 2.68,
      w: 9.9,
      h: deck.titleSize === 'big' ? 1.6 : 1.9,
      fontFace: FONT,
      fontSize: deck.titleSize === 'big' ? PT.coverTitle : PT.coverTitleLong,
      bold: true,
      color: ink.onDeep,
      valign: 'top',
      fit: 'shrink',
    });
  }
  if (!deck.subtitleAbove && deck.subtitle) {
    page.addText(deck.subtitle, {
      x: MX,
      y: 4.4,
      w: 9.2,
      h: 0.7,
      fontFace: FONT,
      fontSize: PT.coverSub,
      color: ink.onDeepMuted,
    });
  }
  page.addShape(pptx.ShapeType.rect, {
    x: MX,
    y: 5.24,
    w: 2.4,
    h: 0.055,
    fill: { color: ink.palette.accentBright },
    line: { color: ink.palette.accentBright, transparency: 100 },
  });
  if (slideCount > 0) {
    page.addText(String(slideCount).padStart(2, '0'), {
      x: SLIDE_W - 3.2,
      y: SLIDE_H - 1.9,
      w: 2.4,
      h: 1.3,
      fontFace: FONT,
      fontSize: 72,
      bold: true,
      align: 'right',
      color: ghostColor(ink),
    });
  }
}

/** Один содержательный слайд. */
export function drawSlide(
  pptx: PptxGenJS,
  page: Page,
  plan: SlidePlan,
  ctx: PageCtx,
  ink: Ink,
): void {
  const deep = plan.layout === 'section';
  if (deep) deepBackground(page, pptx, ink);
  else paperBackground(page, pptx, ink);

  if (plan.layout !== 'section' && plan.layout !== 'statement') drawHead(pptx, page, plan, ink);
  drawBody(pptx, page, plan, ctx, ink);
  drawCites(page, plan.sources, ink);
  footer(page, pptx, ink, ctx.deckTitle, ctx.index, ctx.total, deep);
  if (plan.notes) page.addNotes(plan.notes);
}

/** Слайд с общими источниками колоды. */
export function drawSources(
  pptx: PptxGenJS,
  page: Page,
  sources: DeckSource[],
  ctx: PageCtx,
  ink: Ink,
): void {
  paperBackground(page, pptx, ink);
  ruleShape(page, pptx, ink.palette.accent);
  page.addText('Источники', {
    x: MX,
    y: TITLE_Y,
    w: CONTENT_W,
    h: 0.9,
    fontFace: FONT,
    fontSize: PT.title,
    bold: true,
    color: ink.ink,
  });
  const twoColumns = sources.length > 6;
  const rows = twoColumns ? Math.ceil(sources.length / 2) : sources.length;
  const columnW = twoColumns ? (CONTENT_W - 0.5) / 2 : CONTENT_W;
  const step = Math.min(0.72, (BODY_BOTTOM - BODY_Y) / Math.max(rows, 1));
  sources.forEach((source, at) => {
    const column = twoColumns && at >= rows ? 1 : 0;
    const row = column === 1 ? at - rows : at;
    const x = MX + column * (columnW + 0.5);
    page.addText(
      [
        {
          text: `${String(at + 1).padStart(2, '0')}  `,
          options: { bold: true, color: ink.palette.accent, fontSize: PT.sourceUrl },
        },
        { text: source.title, options: { bold: true, color: ink.ink, fontSize: PT.source } },
        ...(source.url
          ? [
              {
                text: `\n      ${source.url}`,
                options: { color: ink.muted, fontSize: PT.sourceUrl },
              },
            ]
          : []),
      ],
      { x, y: BODY_Y + row * step, w: columnW, h: step, fontFace: FONT, valign: 'top' },
    );
  });
  footer(page, pptx, ink, ctx.deckTitle, ctx.index, ctx.total, false);
}

function drawHead(pptx: PptxGenJS, page: Page, plan: SlidePlan, ink: Ink): void {
  if (!plan.title) return;
  const small = plan.layout === 'figure' || plan.layout === 'quote';
  ruleShape(page, pptx, ink.palette.accent);
  page.addText(plan.title, {
    x: MX,
    y: TITLE_Y,
    w: CONTENT_W,
    h: small ? 0.7 : 0.95,
    fontFace: FONT,
    fontSize: small ? PT.titleSmall : PT.title,
    bold: true,
    color: ink.ink,
    fit: 'shrink',
  });
}

function drawBody(pptx: PptxGenJS, page: Page, plan: SlidePlan, ctx: PageCtx, ink: Ink): void {
  const bottom = plan.sources.length > 0 ? CITES_Y - 0.14 : BODY_BOTTOM;
  switch (plan.layout) {
    case 'section':
      return drawSection(pptx, page, plan, ctx, ink);
    case 'statement':
      return drawStatement(pptx, page, plan, ink);
    case 'stats':
      return drawStats(pptx, page, plan, ink, bottom);
    case 'columns':
      return drawColumns(pptx, page, plan, ink, bottom);
    case 'quote':
      return drawQuote(page, plan, ink, bottom);
    case 'figure':
      return drawFigure(pptx, page, plan, ink, bottom);
    default:
      return drawBullets(pptx, page, plan, ink, bottom);
  }
}

function drawSection(pptx: PptxGenJS, page: Page, plan: SlidePlan, ctx: PageCtx, ink: Ink): void {
  page.addText(String(ctx.index).padStart(2, '0'), {
    x: SLIDE_W - 4.2,
    y: 0.1,
    w: 3.4,
    h: 2.1,
    fontFace: FONT,
    fontSize: 96,
    bold: true,
    align: 'right',
    color: ghostColor(ink),
  });
  page.addShape(pptx.ShapeType.rect, {
    x: MX,
    y: 2.86,
    w: 0.62,
    h: 0.055,
    fill: { color: ink.palette.accentBright },
    line: { color: ink.palette.accentBright, transparency: 100 },
  });
  page.addText(plan.title, {
    x: MX,
    y: 3.1,
    w: 10.2,
    h: 1.38,
    fontFace: FONT,
    fontSize: PT.sectionTitle,
    bold: true,
    color: ink.onDeep,
    fit: 'shrink',
  });
  if (plan.bullets[0]) {
    page.addText(plan.bullets[0], {
      x: MX,
      y: 4.56,
      w: 9.4,
      h: 0.7,
      fontFace: FONT,
      fontSize: PT.sectionLede,
      color: ink.onDeepMuted,
    });
  }
}

function drawStatement(pptx: PptxGenJS, page: Page, plan: SlidePlan, ink: Ink): void {
  page.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 0.2,
    h: SLIDE_H,
    fill: { color: ink.palette.accent },
    line: { color: ink.palette.accent, transparency: 100 },
  });
  page.addShape(pptx.ShapeType.rect, {
    x: 1.34,
    y: 2.2,
    w: 0.62,
    h: 0.055,
    fill: { color: ink.palette.accent },
    line: { color: ink.palette.accent, transparency: 100 },
  });
  const size =
    plan.statementSize === 'small'
      ? PT.statementLong
      : plan.statementSize === 'mid'
        ? PT.statementMid
        : PT.statement;
  page.addText(plan.title, {
    x: 1.34,
    y: 2.5,
    w: 9.6,
    h: 2.1,
    fontFace: FONT,
    fontSize: size,
    bold: true,
    color: ink.ink,
    valign: 'top',
    fit: 'shrink',
  });
  if (plan.bullets[0]) {
    page.addShape(pptx.ShapeType.rect, {
      x: 1.34,
      y: 4.78,
      w: 0.05,
      h: 0.42,
      fill: { color: ink.palette.accent },
      line: { color: ink.palette.accent, transparency: 100 },
    });
    page.addText(plan.bullets[0], {
      x: 1.56,
      y: 4.74,
      w: 8.6,
      h: 0.5,
      fontFace: FONT,
      fontSize: PT.statLabel,
      color: ink.muted,
      valign: 'middle',
    });
  }
}

function drawStats(pptx: PptxGenJS, page: Page, plan: SlidePlan, ink: Ink, bottom: number): void {
  const count = plan.stats.length;
  const gap = 0.34;
  const width = (CONTENT_W - gap * (count - 1)) / Math.max(count, 1);
  const top = Math.max(BODY_Y + 0.5, (BODY_Y + bottom) / 2 - 1.05);
  const size =
    plan.statSize === 'small'
      ? PT.statValueLong
      : plan.statSize === 'mid'
        ? PT.statValueMid
        : PT.statValue;
  plan.stats.forEach((stat, at) => {
    const x = MX + at * (width + gap);
    page.addShape(pptx.ShapeType.rect, {
      x,
      y: top,
      w: width,
      h: 0.05,
      fill: { color: ink.palette.accent },
      line: { color: ink.palette.accent, transparency: 100 },
    });
    page.addText(stat.value, {
      x,
      y: top + 0.18,
      w: width,
      h: 1.0,
      fontFace: FONT,
      fontSize: size,
      bold: true,
      color: ink.palette.accentDeep,
      valign: 'top',
      fit: 'shrink',
    });
    if (stat.label) {
      page.addText(stat.label, {
        x,
        y: top + 1.26,
        w: width,
        h: 0.9,
        fontFace: FONT,
        fontSize: PT.statLabel,
        color: ink.muted,
        valign: 'top',
      });
    }
  });
  const after = plan.bullets.slice(0, 3);
  if (after.length > 0) {
    page.addText(after.join('    ·    '), {
      x: MX,
      y: top + 2.3,
      w: CONTENT_W,
      h: 0.5,
      fontFace: FONT,
      fontSize: PT.statLabel,
      color: ink.muted,
    });
  }
}

function drawColumns(pptx: PptxGenJS, page: Page, plan: SlidePlan, ink: Ink, bottom: number): void {
  const gap = 0.32;
  const count = plan.columns.length;
  const width = (CONTENT_W - gap * (count - 1)) / Math.max(count, 1);
  const height = bottom - BODY_Y;
  plan.columns.forEach((column, at) => {
    const x = MX + at * (width + gap);
    const accented = at === 1;
    const fill = accented ? ink.palette.tint : 'FFFFFF';
    page.addShape(pptx.ShapeType.roundRect, {
      x,
      y: BODY_Y,
      w: width,
      h: height,
      rectRadius: 0.08,
      fill: { color: fill },
      line: {
        color: accented ? mix(ink.palette.tint, ink.palette.accent, 0.3) : ink.line,
        width: 1,
      },
    });
    if (column.title) {
      page.addText(column.title, {
        x: x + 0.28,
        y: BODY_Y + 0.26,
        w: width - 0.56,
        h: 0.5,
        fontFace: FONT,
        fontSize: PT.columnTitle,
        bold: true,
        color: ink.palette.accentDeep,
      });
      page.addShape(pptx.ShapeType.rect, {
        x: x + 0.28,
        y: BODY_Y + 0.82,
        w: 0.42,
        h: 0.04,
        fill: { color: ink.palette.accent },
        line: { color: ink.palette.accent, transparency: 100 },
      });
    }
    if (column.bullets.length > 0) {
      page.addText(bulletRuns(column.bullets), {
        x: x + 0.28,
        y: BODY_Y + 1.04,
        w: width - 0.56,
        h: height - 1.3,
        fontFace: FONT,
        fontSize: PT.statLabel,
        color: ink.ink,
        valign: 'top',
        lineSpacingMultiple: 1.25,
        fit: 'shrink',
      });
    }
  });
}

function drawQuote(page: Page, plan: SlidePlan, ink: Ink, bottom: number): void {
  const middle = (BODY_Y + bottom) / 2;
  page.addText('“', {
    x: MX,
    y: middle - 1.5,
    w: 1.6,
    h: 1.6,
    fontFace: 'Georgia',
    fontSize: 110,
    bold: true,
    color: mix(ink.paper, ink.palette.accent, 0.34),
  });
  page.addText(plan.quote?.text ?? '', {
    x: MX + 1.4,
    y: middle - 1.2,
    w: CONTENT_W - 1.6,
    h: 1.9,
    fontFace: FONT,
    fontSize: PT.quote,
    italic: true,
    color: ink.ink,
    valign: 'middle',
    lineSpacingMultiple: 1.24,
    fit: 'shrink',
  });
  if (plan.quote?.author) {
    page.addText(`— ${plan.quote.author}`, {
      x: MX + 1.4,
      y: middle + 0.86,
      w: CONTENT_W - 1.6,
      h: 0.5,
      fontFace: FONT,
      fontSize: PT.quoteAuthor,
      bold: true,
      color: ink.palette.accentDeep,
    });
  }
}

function drawFigure(pptx: PptxGenJS, page: Page, plan: SlidePlan, ink: Ink, bottom: number): void {
  const captionH = plan.caption ? 0.62 : 0;
  const height = bottom - BODY_Y - captionH;
  frame(pptx, page, ink, MX, BODY_Y, CONTENT_W, height);
  media(page, plan, MX + 0.16, BODY_Y + 0.16, CONTENT_W - 0.32, height - 0.32);
  if (plan.caption) {
    page.addText(plan.caption, {
      x: MX,
      y: bottom - captionH + 0.1,
      w: CONTENT_W,
      h: captionH,
      fontFace: FONT,
      fontSize: PT.caption,
      color: ink.muted,
    });
  }
}

function drawBullets(pptx: PptxGenJS, page: Page, plan: SlidePlan, ink: Ink, bottom: number): void {
  const height = bottom - BODY_Y;
  const withMedia = Boolean(plan.picture ?? plan.figure);
  const textW = withMedia ? 6.15 : CONTENT_W;
  const size =
    plan.tier === 'dense' ? PT.bulletDense : plan.tier === 'airy' ? PT.bulletAiry : PT.bullet;
  if (plan.bullets.length > 0) {
    page.addText(bulletRuns(plan.bullets), {
      x: MX,
      y: BODY_Y,
      w: textW,
      h: height,
      fontFace: FONT,
      fontSize: size,
      color: ink.ink,
      valign: 'middle',
      lineSpacingMultiple: 1.3,
      paraSpaceAfter: size * 0.5,
      fit: 'shrink',
    });
  }
  if (!withMedia) return;
  const x = MX + textW + 0.4;
  const w = MX + CONTENT_W - x;
  if (plan.picture) {
    media(page, { picture: plan.picture }, x, BODY_Y, w, height, 'cover');
    return;
  }
  frame(pptx, page, ink, x, BODY_Y, w, height);
  media(page, plan, x + 0.14, BODY_Y + 0.14, w - 0.28, height - 0.28);
}

/** Белая карточка под схемой: та же рамка, что на странице. */
function frame(
  pptx: PptxGenJS,
  page: Page,
  ink: Ink,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  page.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.06,
    fill: { color: 'FFFFFF' },
    line: { color: ink.line, width: 1 },
  });
}

/**
 * Картинка слайда. Схема уезжает в файл как SVG: PowerPoint кладёт рядом
 * запасной PNG сам (`asvg:svgBlip`), и проверено это открытием файла настоящим
 * PowerPoint, а не документацией.
 */
function media(
  page: Page,
  plan: { picture?: string; figure?: string },
  x: number,
  y: number,
  w: number,
  h: number,
  sizing: 'contain' | 'cover' = 'contain',
): void {
  if (plan.picture) {
    page.addImage({ data: plan.picture, x, y, w, h, sizing: { type: sizing, w, h } });
    return;
  }
  if (!plan.figure) return;
  const data = `data:image/svg+xml;base64,${Buffer.from(plan.figure, 'utf8').toString('base64')}`;
  page.addImage({ data, x, y, w, h, sizing: { type: 'contain', w, h } });
}

/** Сноски слайда одной строкой: название жирным, адрес следом. */
function drawCites(page: Page, sources: DeckSource[], ink: Ink): void {
  if (sources.length === 0) return;
  const runs = sources.flatMap((source, at) => [
    ...(at > 0 ? [{ text: '    ', options: { color: ink.muted } }] : []),
    { text: source.title, options: { bold: true, color: ink.palette.accentDeep } },
    { text: source.url ? ` ${source.url}` : '', options: { color: ink.muted } },
  ]);
  page.addText(runs, {
    x: MX,
    y: CITES_Y,
    w: CONTENT_W,
    h: 0.42,
    fontFace: FONT,
    fontSize: PT.caption,
    color: ink.muted,
    valign: 'middle',
  });
}

/** Пункты списка: один абзац на строку, маркер — квадратик, как на странице. */
function bulletRuns(lines: string[]) {
  return lines.map((line) => ({
    text: line,
    options: { bullet: { characterCode: '25AA' }, breakLine: true },
  }));
}
