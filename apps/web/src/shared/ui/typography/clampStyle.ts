import type { CSSProperties } from 'react';

/**
 * Стиль текста: свой стиль вызывающего плюс число строк обрезки. Обрезка
 * ложится поверх — раньше `style` вызывающего приходил последним и стирал её.
 */
export function clampStyle(
  clamp: number | undefined,
  style: CSSProperties | undefined,
): CSSProperties | undefined {
  return clamp ? { ...style, WebkitLineClamp: clamp } : style;
}
