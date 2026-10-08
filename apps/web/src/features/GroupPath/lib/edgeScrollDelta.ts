/** Полоса у края прокрутки, где взятый шаг тянет список за собой (px). */
export const EDGE = 56;

/** Скорость у самого края, px за кадр; к границе полосы спадает. */
export const MAX_SPEED = 18;

/** Сдвиг за кадр: у верхнего края — вверх, у нижнего — вниз, в середине — ноль. */
export function edgeScrollDelta(y: number, top: number, bottom: number): number {
  if (y < top + EDGE) return -Math.ceil(MAX_SPEED * Math.min(1, (top + EDGE - y) / EDGE));
  if (y > bottom - EDGE) return Math.ceil(MAX_SPEED * Math.min(1, (y - (bottom - EDGE)) / EDGE));
  return 0;
}
