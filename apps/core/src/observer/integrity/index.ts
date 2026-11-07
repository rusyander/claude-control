import { erasePredicate } from '../erase.ts';
import type { Predicate } from '../observer.types.ts';
import { contextGrowth } from './context-growth.ts';
import { resourceLeak } from './resource-leak.ts';
import { spendMisattributed } from './spend-misattributed.ts';
import { windowTransition } from './window.ts';

/**
 * Предикаты целостности (06:140-145): утечка ресурса, окно, рост контекста. `journal-rejected`
 * не здесь: отвергнутой строки в журнале нет — вердикт выносит проводка по крючку писателя.
 * Состояние каждого свёртка хранит непрозрачно (`erasePredicate`).
 */
export const PREDICATES: readonly Predicate[] = [
  erasePredicate(resourceLeak),
  erasePredicate(windowTransition),
  erasePredicate(contextGrowth),
  erasePredicate(spendMisattributed),
];
