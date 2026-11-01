import { erasePredicate } from '../erase.ts';
import type { Predicate } from '../observer.types.ts';
import { stallPredicate } from './stall.ts';

/**
 * Предикат тишины сессии (06:138-139): `stall` по строкам `session.probe`. Реестр наблюдателя
 * берёт список отсюда; порог и пробу считает проводка (`bootstrap/observer-wiring/stall.ts`).
 */
export const PREDICATES: readonly Predicate[] = [erasePredicate(stallPredicate)];

export { stallPredicate, STALL_SIGNAL, formatQuiet } from './stall.ts';
export {
  MODEL_CLASS,
  sessionStallThreshold,
  stallThreshold,
  STALL_DEFAULT_MS,
  STALL_FLOOR_MS,
  type StallThreshold,
} from './threshold.ts';
