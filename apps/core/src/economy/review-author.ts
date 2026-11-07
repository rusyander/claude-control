import type { StepRecord, TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { defaultRoleOf } from './tier-ladder.ts';

/**
 * Автор того, что смотрит ревью (P35, 06:8) — одно правило на суд `tier` (пол ревьюера,
 * `routing-facts.ts`) и на команду `set-model` (предупреждение «ревьюер ниже автора»): разные
 * правила дали бы предупреждение по одному автору, а подъём на старте шага — по другому.
 *
 * Автор — последний шаг той же единицы, начатый раньше ревью, из шагов, которые пишут код:
 * сначала работа и правки (`work`, `fix`) — настоящий автор единицы; свой шаг и ответы ревьюерам
 * (прочие шаги роли `implement`) — только когда работы и правок нет. Соседний свой шаг, начатый
 * после работы, но не её часть, ревьюера к себе не поднимает. Разбор, разведка и план кода не
 * пишут — не авторы вовсе.
 */

const PRIMARY_KINDS: ReadonlySet<string> = new Set(['work', 'fix']);

export interface ReviewRef {
  /** `null` — шаг ревью ещё не начат: в счёт идут все начатые шаги единицы. */
  stepId: string | null;
  unitId: string | null;
}

/** Id шага-автора или `null`; `eligible` — доп. условие на кандидата (у суда — решение `tier`). */
export function reviewAuthorOf(
  state: TaskFoldState,
  review: ReviewRef,
  eligible: (stepId: string) => boolean = () => true,
): string | null {
  const { unitId } = review;
  if (unitId === null) return null;
  const before = review.stepId ? state.steps[review.stepId]?.startedSeq : undefined;
  const latest = (pick: (s: StepRecord) => boolean): string | null => {
    let best: [string, number] | null = null;
    for (const [id, s] of Object.entries(state.steps)) {
      if (s.unitId !== unitId || !pick(s) || !eligible(id)) continue;
      if (before !== undefined && s.startedSeq >= before) continue;
      if (!best || s.startedSeq > best[1]) best = [id, s.startedSeq];
    }
    return best ? best[0] : null;
  };
  return (
    latest((s) => PRIMARY_KINDS.has(s.stepKind)) ??
    latest((s) => defaultRoleOf(s.stepKind) === 'implement')
  );
}
