import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { SplitCheckDecision, SplitUnit } from '../split-check/index.ts';
import type { UnitBase, UnitCreated } from './units.types.ts';

/**
 * Единицы принятого деления (02:73-74, 02:82-84, G19): по одной на предложенную, в порядке проверки
 * (он же порядок публикации); `after` — id предшественников по рёбрам зависимостей и контракта;
 * ветка — своя у каждой. Основа ветки решается при старте единицы: от ветки последнего
 * предшественника того же репозитория, иначе от приколотой базы задачи. Предшественник из другого
 * репозитория — только порядок (контракт раньше потребителя), не основа: чужую историю в ветку
 * не вливают.
 */

export function unitBranch(unitId: string): string {
  return `agentdeck/${unitId.slice(-8)}`;
}

export function unitsOfSplit(
  decision: Extract<SplitCheckDecision, { verdict: 'accepted' }>,
  units: readonly SplitUnit[],
  splitId: string,
  newId: () => string,
): UnitCreated[] {
  const ids = new Map(decision.order.map((name) => [name, newId()]));
  return decision.order.map((name) => {
    const u = units.find((x) => x.name === name) as SplitUnit;
    const unitId = ids.get(name) as string;
    const after = decision.edges
      .filter((e) => e.to === name)
      .map((e) => ids.get(e.from) as string)
      .filter((id, i, all) => all.indexOf(id) === i);
    return {
      unitId,
      name,
      repoKey: u.repoKey,
      branch: unitBranch(unitId),
      ownedPaths: [...u.ownedPaths],
      after,
      contract: u.contract,
      splitId,
      // Роль куска плана ведущего после проверки (этап 11); без договора плана роли нет.
      ...(decision.roles?.[name] ? { role: decision.roles[name] } : {}),
    };
  });
}

/**
 * Основа ветки единицы. `units` — все единицы задачи в порядке создания (он же порядок публикации
 * внутри деления): из нескольких предшественников того же репозитория берётся последний — его
 * ветка уже несёт правки остальных, если они были ему предшественниками.
 */
export function unitBaseOf(
  unit: Pick<UnitCreated, 'repoKey' | 'after'>,
  units: readonly UnitCreated[],
  repos: JournalDataV1['task.created']['repos'],
): UnitBase | { unknown: string } {
  const preds = units.filter((u) => unit.after.includes(u.unitId) && u.repoKey === unit.repoKey);
  const last = preds.at(-1);
  if (last) return { kind: 'predecessor', unitId: last.unitId, branch: last.branch };
  const pin = repos.find((r) => r.repoKey === unit.repoKey);
  if (!pin) return { unknown: `repo ${unit.repoKey} is not a repo of this task` };
  return { kind: 'base', repoKey: pin.repoKey, ref: pin.baseRef, sha: pin.baseRef };
}
