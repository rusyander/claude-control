import type { CheckRegistry, TreeRow } from '@agentdeck/contracts/core/records';
import { changedPaths } from '../../platform/git.ts';
import { closureOf, covers } from '../../verifier/key/index.ts';

/**
 * Изменённые единицы копии (04:56, D§3.2): единица изменена, если путь из её замыкания (свои
 * пути + пути потребляемых единиц) отличается от базы. Тронута обвязка (конфиг раннера, скрипт
 * гейта) — изменены все: она входит в ключ каждой единицы. Посреди работы гонятся только они.
 * Сравнение путей — `platform/git/diff.ts` (то же, что дифф единицы после шага).
 */

export function changedUnitsOf(
  registry: CheckRegistry,
  rows: readonly TreeRow[],
  baseRows: readonly TreeRow[],
): string[] {
  const paths = changedPaths(rows, baseRows);
  const units = Object.keys(registry.units).sort();
  if (paths.some((p) => registry.machinery.some((m) => covers(m, p)))) return units;
  return units.filter((u) => {
    const closure = closureOf(registry, u);
    return paths.some((p) => closure.some((c) => covers(c, p)));
  });
}
