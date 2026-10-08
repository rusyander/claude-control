import type { PathRow } from './pathRows.types';

/**
 * Есть ли «+» после строки `index`. Между любыми двумя строками — да: рядом с
 * шагами скилла вставка идёт внутрь его порядка (`slotAfter`). Нет только
 * перед строкой «скилл целиком»: у такого скилла нет шагов, между которыми
 * встать, и шаг ушёл бы ниже неё — «+» соврал бы о месте.
 */
export function canInsertAfter(rows: PathRow[], index: number): boolean {
  return rows[index + 1]?.kind !== 'skill';
}
