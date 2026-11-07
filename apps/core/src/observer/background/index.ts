import { erasePredicate } from '../erase.ts';
import type { Predicate } from '../observer.types.ts';
import { childOutlivedParent } from './child-outlived.ts';

export { BG_ORPHAN_SIGNAL, orphanPlan, orphanVerdict } from './orphan.ts';
export type { BgLiveness, OrphanPlan, ReapOutcome } from './orphan.ts';
export { BG_HANG_AFTER_MS, BG_HANG_SIGNAL, HANG_EXEMPT, hangStep } from './hang.ts';
export type { HangMark } from './hang.ts';
export { CHILD_OUTLIVED_PARENT_SIGNAL } from './child-outlived.ts';

/**
 * Сторож фона (этап 11, P148). Предикат журнала — только «ребёнок пережил родителя»: он судится
 * по строкам. Сирота и зависание зависят от ОС (жив ли процесс, растёт ли файл вывода) — их чистые
 * правила здесь (`orphanPlan`, `hangStep`), а замеры и запись ведёт `bootstrap/agents-wiring`.
 */
export const PREDICATES: readonly Predicate[] = [erasePredicate(childOutlivedParent)];
