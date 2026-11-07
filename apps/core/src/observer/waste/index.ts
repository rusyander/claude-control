import { erasePredicate } from '../erase.ts';
import type { Predicate } from '../observer.types.ts';
import { bigReadPredicate } from './big-read.ts';
import { failRepeatPredicate } from './fail-repeat.ts';
import { pollPredicate } from './poll.ts';
import { refusalRepeatPredicate } from './refusal-repeat.ts';
import { rereadPredicate } from './reread.ts';
import { spendOverEstimate } from './spend-over-estimate.ts';

/**
 * Предикаты расточительства (06:134-137): перечитывание, большое чтение, повтор сбоя, цикл
 * ожидания, повтор отказа. Реестр наблюдателя берёт список отсюда. Состояние каждого предиката —
 * его собственное: свёртка хранит его непрозрачно (`erasePredicate`).
 */
export const PREDICATES: readonly Predicate[] = [
  erasePredicate(rereadPredicate),
  erasePredicate(bigReadPredicate),
  erasePredicate(failRepeatPredicate),
  erasePredicate(pollPredicate),
  erasePredicate(refusalRepeatPredicate),
  erasePredicate(spendOverEstimate),
];
