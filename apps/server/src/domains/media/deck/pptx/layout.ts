import type PptxGenJS from 'pptxgenjs';
import {
  DECK_FONT_PPTX,
  DECK_H_IN,
  DECK_INK,
  DECK_LINE,
  DECK_MUTED,
  DECK_ON_DEEP,
  DECK_ON_DEEP_MUTED,
  DECK_PAPER,
  DECK_W_IN,
  type DeckPalette,
  mix,
} from '../theme.ts';

/**
 * Сетка слайда PowerPoint и общие его части.
 *
 * Размеры здесь в дюймах, а кегль — в пунктах, и оба ряда получены из вёрстки
 * страницы делением: слайд 13.333in × 7.5in — это ровно 1280 × 720 пикселей при
 * 96 на дюйм, поэтому пиксель страницы равен 0.75 пункта файла. Так колода,
 * показанная с экрана и открытая с флешки, остаётся одной колодой.
 *
 * Ничего мельче 14pt (18 пикселей) на лице слайда нет: презентацию смотрят с
 * проектора через полкомнаты.
 */

/** Тип слайда у pptxgenjs не вынесен в экспорт — берём его у самого метода. */
export type Page = ReturnType<PptxGenJS['addSlide']>;

export const SLIDE_W = DECK_W_IN;
export const SLIDE_H = DECK_H_IN;
/** Поля. Те же 6u и 4.6u, что на странице. */
export const MX = 0.92;
export const CONTENT_W = SLIDE_W - MX * 2;
/** Планка акцента над заголовком. */
export const RULE_Y = 0.66;
export const TITLE_Y = 0.88;
/** Верх содержимого и два его низа: со сносками и без. */
export const BODY_Y = 2.15;
export const BODY_BOTTOM = 6.32;
export const CITES_Y = 6.0;
export const FOOT_LINE_Y = 6.62;
export const FOOT_TEXT_Y = 6.74;

export const FONT = DECK_FONT_PPTX;

/**
 * Кегли, в пунктах: пиксель страницы × 0.75.
 *
 * Текстовые кегли равны странице ровно. Крупные — заголовки, числа, врез,
 * цитата — держатся НИЖЕ страничных примерно на десятую: страница переносит и
 * ужимает текст сама, а PowerPoint этого не делает. `fit: 'shrink'` кладёт в
 * файл `normAutofit`, но пересчитывает его PowerPoint только при правке текста,
 * то есть на открытом файле длинный заголовок вылезет за поле. Разница в кегле —
 * плата за то, что в чужой колоде ничего не обрежется.
 */
export const PT = {
  coverTitle: 44,
  coverTitleLong: 34,
  coverSub: 19,
  eyebrow: 14,
  sectionTitle: 44,
  sectionLede: 18,
  title: 30,
  titleSmall: 24,
  statement: 42,
  statementMid: 34,
  statementLong: 27,
  statValue: 58,
  statValueMid: 44,
  statValueLong: 32,
  statLabel: 15,
  bullet: 18,
  bulletAiry: 24,
  bulletDense: 15,
  columnTitle: 19,
  quote: 27,
  quoteAuthor: 16,
  caption: 14,
  foot: 14,
  source: 17,
  sourceUrl: 13,
} as const;

/** Цвета слайда одним набором: раскладки не должны знать про палитру. */
export interface Ink {
  palette: DeckPalette;
  ink: string;
  paper: string;
  muted: string;
  line: string;
  onDeep: string;
  onDeepMuted: string;
}

export function inkFor(palette: DeckPalette): Ink {
  return {
    palette,
    ink: DECK_INK,
    paper: DECK_PAPER,
    muted: DECK_MUTED,
    line: DECK_LINE,
    onDeep: DECK_ON_DEEP,
    onDeepMuted: DECK_ON_DEEP_MUTED,
  };
}

/**
 * Подложка тёмного слайда. Градиентной заливки в pptxgenjs нет, поэтому глубина
 * набрана фигурами: диагональная полоса второго тона и светлое пятно в углу —
 * то же, что радиальные градиенты на странице.
 */
export function deepBackground(page: Page, pptx: PptxGenJS, ink: Ink): void {
  page.background = { color: ink.palette.deep };
  page.addShape(pptx.ShapeType.rect, {
    x: 5.9,
    y: -2.6,
    w: 9.4,
    h: 12.6,
    rotate: 17,
    fill: { color: ink.palette.deepAlt, transparency: 42 },
    line: { color: ink.palette.deepAlt, transparency: 100 },
  });
  page.addShape(pptx.ShapeType.ellipse, {
    x: 8.9,
    y: -3.6,
    w: 8.4,
    h: 6.8,
    fill: { color: ink.palette.accentBright, transparency: 88 },
    line: { color: ink.palette.accentBright, transparency: 100 },
  });
}

/**
 * Подложка светлого слайда: та же мягкая подсветка углов, что на странице.
 *
 * Пятна намеренно вынесены ЗА край слайда и держатся почти прозрачными: у
 * PowerPoint нет размытия, и видимая дуга окружности читается как нарисованный
 * круг, а не как подсветка. Значения ниже — предел, на котором на выгруженном
 * кадре край уже не виден, а тон угла ещё есть.
 */
export function paperBackground(page: Page, pptx: PptxGenJS, ink: Ink): void {
  page.background = { color: ink.paper };
  page.addShape(pptx.ShapeType.ellipse, {
    x: 8.6,
    y: -4.3,
    w: 8.8,
    h: 7.1,
    fill: { color: ink.palette.accent, transparency: 95 },
    line: { color: ink.palette.accent, transparency: 100 },
  });
  page.addShape(pptx.ShapeType.ellipse, {
    x: -3.4,
    y: 5.1,
    w: 6.8,
    h: 5.6,
    fill: { color: ink.palette.accent, transparency: 96 },
    line: { color: ink.palette.accent, transparency: 100 },
  });
}

/**
 * Цвет призрачного номера на тёмном слайде.
 *
 * Считается от ВТОРОГО тона фона, а не от базового: полупрозрачного текста в
 * OOXML нет, а номер лежит поверх диагональной полосы и углового пятна — смесь с
 * базовым тоном давала цифру темнее подложки под ней, и та читалась грязью.
 * На странице номер белый малой непрозрачности и потому светлее всего под собой;
 * здесь тот же результат получен смесью с более светлым краем фона.
 */
export function ghostColor(ink: Ink): string {
  return mix(ink.palette.deepAlt, ink.onDeep, 0.3);
}

/** Планка акцента над заголовком. */
export function ruleShape(page: Page, pptx: PptxGenJS, color: string, y = RULE_Y): void {
  page.addShape(pptx.ShapeType.rect, {
    x: MX,
    y,
    w: 0.62,
    h: 0.055,
    fill: { color },
    line: { color, transparency: 100 },
  });
}

/** Нижняя планка: название колоды, ход и номер. На обложке её нет. */
export function footer(
  page: Page,
  pptx: PptxGenJS,
  ink: Ink,
  deckTitle: string,
  index: number,
  total: number,
  deep: boolean,
): void {
  const lineColor = deep ? mix(ink.palette.deep, ink.onDeep, 0.26) : ink.line;
  const textColor = deep ? ink.onDeepMuted : ink.muted;
  const numColor = deep ? ink.onDeep : ink.ink;
  const accent = deep ? ink.palette.accentBright : ink.palette.accent;
  page.addShape(pptx.ShapeType.rect, {
    x: MX,
    y: FOOT_LINE_Y,
    w: CONTENT_W,
    h: 0.012,
    fill: { color: lineColor },
    line: { color: lineColor, transparency: 100 },
  });
  if (deckTitle) {
    page.addText(deckTitle, {
      x: MX,
      y: FOOT_TEXT_Y,
      w: 7.4,
      h: 0.34,
      fontFace: FONT,
      fontSize: PT.foot,
      color: textColor,
      valign: 'middle',
    });
  }
  const track = 1.62;
  const done = Math.max(0.04, Math.min(1, index / Math.max(total, 1))) * track;
  page.addShape(pptx.ShapeType.rect, {
    x: 9.35,
    y: FOOT_TEXT_Y + 0.14,
    w: track,
    h: 0.05,
    fill: { color: lineColor },
    line: { color: lineColor, transparency: 100 },
  });
  page.addShape(pptx.ShapeType.rect, {
    x: 9.35,
    y: FOOT_TEXT_Y + 0.14,
    w: done,
    h: 0.05,
    fill: { color: accent },
    line: { color: accent, transparency: 100 },
  });
  page.addText(`${index} / ${total}`, {
    x: 11.2,
    y: FOOT_TEXT_Y,
    w: MX + CONTENT_W - 11.2,
    h: 0.34,
    fontFace: FONT,
    fontSize: PT.foot,
    bold: true,
    color: numColor,
    align: 'right',
    valign: 'middle',
  });
}
