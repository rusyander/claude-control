import type { OverrideRow, PickSource } from './tier.types.ts';

/**
 * Правка человека для судьи `tier` (03 §Economy): какое значение поля действует на шаге и с
 * какого уровня. Вынесено из `tier.ts` — судья только читает итог.
 */

type Field = OverrideRow['field'];

export interface Picked {
  value: string | null;
  source: PickSource | null;
}

/**
 * Правка поля: шаг уже единицы, единица уже задачи; внутри уровня — последняя строка. Последняя
 * строка уровня со значением `null` снимает правку этого уровня — решает уровень шире.
 */
export function overrideFor(
  rows: readonly OverrideRow[],
  field: Field,
  ids: { taskId: string; unitId: string | null; stepId: string | null },
): Picked {
  const levels = [
    { scope: 'step', id: ids.stepId, source: 'override-step' },
    { scope: 'unit', id: ids.unitId, source: 'override-unit' },
    { scope: 'task', id: ids.taskId, source: 'override-task' },
  ] as const;
  for (const level of levels) {
    if (level.id === null) continue;
    const last = rows
      .filter((r) => r.field === field && r.scope === level.scope && r.scopeId === level.id)
      .reduce<OverrideRow | null>((max, r) => (max === null || r.seq > max.seq ? r : max), null);
    if (last?.value) return { value: last.value, source: level.source };
  }
  return { value: null, source: null };
}

export const isOverride = (s: PickSource | null): boolean =>
  s !== null && s.startsWith('override-');
