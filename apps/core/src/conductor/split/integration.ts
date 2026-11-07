import type { LiveTask } from '../../journal/resume.ts';
import { INTEGRATION_ROLE, INTEGRATION_UNIT_NAME } from '../gates/integrated.ts';
import { unitBranch, type UnitCreated } from '../units/index.ts';

/**
 * Единица интеграции на запуске деления (этап 11, W3-18b): план L/XL задачи ведущего, где в одном
 * репозитории ≥ 2 единицы идут параллельно (ни одна не ждёт другую ни прямо, ни через третью),
 * получает единицу роли `integrate` после всех единиц этого репозитория. Цепочка единиц уже
 * сливается сама (ветка от ветки предшественника) — ей интеграция не нужна.
 */

const INTEGRATED_CLASSES: ReadonlySet<string> = new Set(['L', 'XL']);

/** Все предшественники единицы (транзитивно) по `after`. */
function ancestorsOf(unitId: string, byId: ReadonlyMap<string, UnitCreated>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(byId.get(unitId)?.after ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.after ?? []));
  }
  return seen;
}

/** Есть ли среди единиц пара, где ни одна не предок другой. */
export function hasParallelPair(units: readonly UnitCreated[]): boolean {
  const byId = new Map(units.map((u) => [u.unitId, u]));
  const anc = new Map(units.map((u) => [u.unitId, ancestorsOf(u.unitId, byId)]));
  for (const [i, a] of units.entries())
    for (const b of units.slice(i + 1))
      if (!anc.get(a.unitId)?.has(b.unitId) && !anc.get(b.unitId)?.has(a.unitId)) return true;
  return false;
}

/** Единицы интеграции к созданным единицам деления (по одной на репозиторий с параллелью). */
export function integrationUnitsOf(
  task: LiveTask,
  made: readonly UnitCreated[],
  splitId: string,
  newId: () => string,
): UnitCreated[] {
  if (!task.state.created?.lead) return [];
  const cls = task.state.lead?.taskClass?.class;
  if (cls === undefined || !INTEGRATED_CLASSES.has(cls)) return [];
  const repos = [...new Set(made.map((u) => u.repoKey))];
  const out: UnitCreated[] = [];
  for (const repoKey of repos) {
    const own = made.filter((u) => u.repoKey === repoKey);
    if (own.length < 2 || !hasParallelPair(own)) continue;
    const unitId = newId();
    out.push({
      unitId,
      name: repos.length > 1 ? `${INTEGRATION_UNIT_NAME}-${repoKey}` : INTEGRATION_UNIT_NAME,
      repoKey,
      branch: unitBranch(unitId),
      ownedPaths: [],
      after: own.map((u) => u.unitId),
      contract: false,
      splitId,
      role: INTEGRATION_ROLE,
    });
  }
  return out;
}
