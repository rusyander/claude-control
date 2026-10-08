import { DOCK_WIDTH_MIN } from './dockWidth.constants';

/** Шире — страница рядом перестаёт читаться, какой бы ни был экран. */
export const DOCK_WIDTH_CEILING = 960;

/** Сколько страницы остаётся видно слева от окна при любой ширине. */
export const PAGE_MIN_VISIBLE = 480;

/** С этой ширины окна браузера окно агента сдвигает страницу и тянется. */
export const DOCK_WIDE_FROM = 900;

/** Верхняя граница для этого окна браузера; не меньше нижней. */
export function dockWidthMax(viewport: number): number {
  return Math.max(DOCK_WIDTH_MIN, Math.min(DOCK_WIDTH_CEILING, viewport - PAGE_MIN_VISIBLE));
}
