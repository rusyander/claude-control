import type { PathEntry, PathStep } from '@agentdeck/contracts';
import { placed } from './placed';
import { slotAfter } from './slotAfter';
import { renumber } from './renumber';
import { isScenarioPath } from './isScenarioPath';
import { SCENARIO_ANCHOR } from './pathEdit.constants';
import { customSteps } from './pathEdit';

/**
 * Вставить шаг после строки `index` пути. Шаг получает место этой вставки
 * (`slotAfter`) и встаёт за последним своим шагом, стоящим не ниже неё.
 */
export function insertAfter(entries: PathEntry[], index: number, step: PathStep): PathStep[] {
  const before = customSteps(entries.slice(0, index + 1));
  const after = customSteps(entries.slice(index + 1));
  const steps = [...before, placed(step, slotAfter(entries, index)), ...after];
  // Сценарий из прежних сохранений мог нести шаги под разными стадиями: они
  // сводятся в один ряд в том порядке, в каком их видит человек.
  return renumber(
    isScenarioPath(entries)
      ? steps.map((item) =>
          item.anchor === SCENARIO_ANCHOR ? item : { ...item, anchor: SCENARIO_ANCHOR },
        )
      : steps,
  );
}
