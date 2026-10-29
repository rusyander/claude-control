import { isAbsolute, resolve } from 'node:path';
import { isInside } from '../../platform/paths.ts';
import type { FoldedPaths } from './context-paths.ts';
import type { PermitDecision } from './permit.types.ts';

/** Общие помощники веток судьи (`permit.ts`, `read-scope.ts`): одна форма отказа, одно сравнение. */

export type Refusal = Extract<PermitDecision, { allow: false }>;

/**
 * Итог ветки чтения (`read-scope.ts`, `read-links.ts`): чтение не несёт сигнала владения — его
 * ставит только правка. Решение класса `permit` отдаёт один `decidePermit` (P01), ветка — лишь
 * свой итог, который судья возвращает как есть.
 */
export type ReadVerdict = Refusal | { allow: true; signal: null; reason: string };

export function deny(code: Refusal['code'], reason: string, humanPoint: 3 | 5 | null): Refusal {
  return { allow: false, code, reason, humanPoint };
}

// Корень копии и списки путей — из `foldedPaths`: сложены той же функцией, что и цель (H7).
export function absolute(paths: FoldedPaths, target: string): string {
  return isAbsolute(target) ? target : resolve(paths.copyRoot, target);
}

/** Путь внутри одного из корней списка (по ключам: регистр, 8.3, ссылки раскрыты). */
export function underAny(path: string, list: readonly string[]): boolean {
  return list.some((root) => isInside(root, path));
}

/** Предок пути из списка: поиск или чтение по нему дойдёт до этого пути (F-13). */
export function ancestorOfAny(path: string, list: readonly string[]): boolean {
  return list.some((root) => isInside(path, root));
}
