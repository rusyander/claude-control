import type { Fact } from '@agentdeck/contracts/core/facts';
import { reviewBaseOf, unitCopyOf } from '../conductor/copy/index.ts';
import type { SessionBinding } from '../conductor/model-tools/model-tools.types.ts';
import type { UnitDiffDeps } from '../conductor/model-tools/unit-diff.ts';
import type { LiveTask } from '../journal/resume.ts';
import { diffFileOf, diffUnit } from '../platform/git.ts';

/**
 * Чтения инструмента `unit_diff`: копия единицы сессии и её закреплённая база. Копии нет — отказ,
 * а не папка репозитория задачи: дифф рабочей папки человека показал бы ревьюеру чужие правки
 * под видом правок единицы. База — только sha, закреплённый при создании копии: имя ветки
 * (`baseRef`) уходит вперёд, и дифф от него подмешал бы чужие коммиты под видом правок единицы.
 */
export function unitDiffFacts(
  task: LiveTask,
  b: SessionBinding,
  known?: readonly string[],
): Fact<UnitDiffDeps> {
  const copy = unitCopyOf(task, b.unitId);
  if (!copy) return { unknown: `unit ${b.unitId} has no copy` };
  // Ревью MR по ссылке (этап 10, F8): дифф от общего предка с целевой веткой — изменения MR.
  const base = reviewBaseOf(task, b.unitId);
  if (!base) return { unknown: `unit ${b.unitId} has no pinned base` };
  return {
    value: {
      changed: () => diffUnit(copy.dir, base),
      diffOf: (file) => diffFileOf(copy.dir, base, file),
      ...(known && known.length > 0 ? { known } : {}),
    },
  };
}

/** `unit_diff` загрузки: секреты окружения сеанса (P61) маскируются и в теле диффа. */
export function unitDiffWiring(
  known?: (taskId: string, sessionId: string) => readonly string[],
): (task: LiveTask, b: SessionBinding) => Fact<UnitDiffDeps> {
  return (task, b) => unitDiffFacts(task, b, known?.(b.taskId, b.sessionId));
}
