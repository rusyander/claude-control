import type { CheckRegistry, TreeRow } from '@agentdeck/contracts/core/records';
import { closureOf, covers } from '../../verifier/key/index.ts';

/**
 * Изменённые единицы копии (04:56, D§3.2): единица изменена, если путь из её замыкания (свои
 * пути + пути потребляемых единиц) отличается от базы. Тронута обвязка (конфиг раннера, скрипт
 * гейта) — изменены все: она входит в ключ каждой единицы. Посреди работы гонятся только они.
 */

export function changedPaths(rows: readonly TreeRow[], baseRows: readonly TreeRow[]): string[] {
  const base = new Map(baseRows.map((r) => [r.path, `${r.mode} ${r.blob}`]));
  const out = new Set<string>();
  for (const r of rows) {
    if (base.get(r.path) !== `${r.mode} ${r.blob}`) out.add(r.path);
    base.delete(r.path);
  }
  for (const gone of base.keys()) out.add(gone);
  return [...out].sort();
}

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
