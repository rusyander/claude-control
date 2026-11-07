import { PREDICATES as BACKGROUND } from './background/index.ts';
import type { Predicate } from './observer.types.ts';
import { PREDICATES as INTEGRITY } from './integrity/index.ts';
import { PREDICATES as STALL } from './stall/index.ts';
import { PREDICATES as WASTE } from './waste/index.ts';

/**
 * Все предикаты наблюдателя в постоянном порядке (waste, stall, integrity, background): свёртка зовёт их по
 * каждой строке журнала. Новый предикат входит через `index.ts` своей папки, не сюда.
 */
export const OBSERVER_PREDICATES: readonly Predicate[] = [
  ...WASTE,
  ...STALL,
  ...INTEGRITY,
  ...BACKGROUND,
];
