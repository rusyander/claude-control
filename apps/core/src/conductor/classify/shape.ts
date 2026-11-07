import type { Scenario } from '@agentdeck/contracts/core/scenario';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { leadAskOpen, leadSkipOf } from '../next/lead-gate.ts';
import { estimateScope } from '../next/next.ts';
import type { ProposedUnit } from '../split/split.types.ts';

/**
 * Класс → форма (D22): S пропускает план, и точки деления у оценки тогда нет — деление «одна
 * единица» предлагает ядро само, иначе оценка ждала бы деления вечно (план не шёл, его крючок не
 * звался). Решает судья формы `next/lead-gate.ts` — здесь только «всё ли, что осталось до точки
 * деления, будет пропущено».
 */

const SETTLED = new Set(['done', 'skipped']);

/** Остаток оценки после шага `currentDefId` пропускается весь (и он не пуст) — нужно соло. */
export function soloSplitDue(
  state: TaskFoldState,
  scenario: Scenario,
  currentDefId: string | null,
): boolean {
  if (state.task !== 'estimating' || Object.keys(state.splits).length > 0) return false;
  // Вопрос класса или карточки открыт — форма не решена: ответ «L» вернул бы план, а деление уже
  // лежало бы. Соло предложит ответ человека (`settleLeadAnswer`), если класс так и остался S.
  if (leadAskOpen(state)) return false;
  const scope = estimateScope(scenario);
  if (!scope) return false;
  const settled = new Set(
    Object.values(state.steps)
      .filter((s) => SETTLED.has(s.state))
      .map((s) => s.stepDefId),
  );
  const remaining = scope.steps.filter((d) => d.id !== currentDefId && !settled.has(d.id));
  return remaining.length > 0 && remaining.every((d) => leadSkipOf(state, d) !== null);
}

/** Соло: единица 0 как есть (её имя, репозиторий, свои пути) — как деление без плана. */
export function soloUnitOf(state: TaskFoldState): ProposedUnit[] {
  const zero = Object.values(state.units).find((u) => u.splitId === null);
  return [
    {
      name: zero?.name ?? 'estimate',
      repoKey: zero?.repoKey ?? state.created?.repos[0]?.repoKey ?? '(not named)',
      ownedPaths: zero?.ownedPaths ?? ['**'],
      deps: [],
      contract: false,
      estimate: { minutes: null, tokens: null },
    },
  ];
}
