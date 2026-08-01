import type { SpaceValue } from './stack.types';

/** Число трактуем как пиксели, строку — как готовое значение CSS (токен, проценты). */
export function toCss(value: SpaceValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}
