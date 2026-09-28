import type { PopoverPlacement, PopoverPlaceInput } from './placeBeside.types';

/**
 * Место окна наблюдателя: справа от ВИДИМОГО края строки, целиком в экране.
 *
 * Строка в свёрнутой боковой панели шире самой панели (подпись спрятана за её
 * краем), поэтому край строки — не опора: на телефоне 400 px окно вставало на
 * 244 px и уходило за правый край экрана на полторы сотни пикселей (28.09).
 * Опора — правый край того, что видно (панели), а по горизонтали окно, как и
 * по вертикали, прижимается внутрь экрана с отступом.
 */
export function placePopover({
  anchor,
  clip,
  width,
  height,
  viewport,
  gap,
  margin,
}: PopoverPlaceInput): PopoverPlacement {
  const visibleRight = clip ? Math.min(anchor.right, clip.right) : anchor.right;
  const left = Math.min(visibleRight + gap, viewport.width - margin - width);
  const top = Math.min(anchor.top, viewport.height - margin - height);
  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}
