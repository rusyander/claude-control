import { REVIEW_LINK_PRESET } from '@agentdeck/contracts/core/review-link';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import {
  REVIEW_DECIDE_STEP,
  REVIEW_PUSH_STEP,
  decideKeyOf,
  pushKeyOf,
  type ReviewDecideKey,
  type ReviewPushKey,
} from '../scenario/review-link-asks.ts';
import { asksBy } from './active.ts';
import { latest, satisfied, topoOrder, unitView } from './attempts.ts';
import type { NextAction, UnitView } from './next.types.ts';

/**
 * Правила сценария `review-link@1` (этап 10, F8) — какие шаги идут после ревью, решает ответ
 * человека, а не порядок шагов. Перенос карточки ревью старой панели:
 * - ревью без замечаний — единица кончается, вопроса нет (старая группа закрывалась без карточки);
 * - «ничего не делать» — единица кончается;
 * - «починить» / «оба» — правка, затем вопрос пуша; «отписать» — правка и пуш пропускаются;
 * - пуш «не отправлять» — финальная проверка не нужна: «оба» всё равно публикует итог заметкой,
 *   «починить» кончает единицу (правки остаются в копии);
 * - «отправить» — финальная проверка и публикация (пуш в ветку MR, итог заметкой при «оба»).
 * Чистая функция: тот же журнал — то же действие (P11). `null` — решает общий порядок `next`.
 */

/** Коды причины конца единицы по решению (префикс — по нему конец задачи не провал). */
export const REVIEW_LINK_END = {
  clean: 'review-link-clean',
  declined: 'review-link-declined',
  notSent: 'review-link-not-sent',
} as const;

export const isReviewLink = (state: TaskFoldState): boolean =>
  state.created?.scenario.id === REVIEW_LINK_PRESET;

/** Ответ человека на последний вопрос шага сценария единицы; не отвечен — `undefined`. */
function answerOf(state: TaskFoldState, view: UnitView, defId: string): string | undefined {
  const last = latest(view, defId);
  if (!last || last.rec.state !== 'done') return undefined;
  const answered = asksBy(state, (a) => a.stepId === last.stepId && a.answer !== undefined);
  return answered.pop()?.answer;
}

export interface ReviewLinkFacts {
  findings: number;
  decide: ReviewDecideKey | undefined;
  push: ReviewPushKey | undefined;
  /** Ответ на вопрос есть, но не из таблицы (чужой текст) — то же, что «ничего не делать». */
  foreignAnswer: boolean;
}

export function reviewLinkFacts(state: TaskFoldState, view: UnitView): ReviewLinkFacts {
  const review = latest(view, 'review');
  const findings = review?.rec.claim?.call.findings?.length ?? 0;
  const rawDecide = answerOf(state, view, REVIEW_DECIDE_STEP);
  const rawPush = answerOf(state, view, REVIEW_PUSH_STEP);
  const decide = decideKeyOf(rawDecide);
  const push = pushKeyOf(rawPush);
  return {
    findings,
    decide,
    push,
    foreignAnswer:
      (rawDecide !== undefined && decide === undefined) ||
      (rawPush !== undefined && push === undefined),
  };
}

type Plan = NextAction | null;

const close = (unitId: string, code: string, why: string): NextAction => ({
  kind: 'end-unit',
  unitId,
  event: 'close',
  reason: `${code}: ${why}`,
});

const skip = (unitId: string, defId: string, why: string): NextAction => ({
  kind: 'skip-step',
  unitId,
  stepDefId: defId,
  round: 0,
  basis: 'core',
  reason: why,
});

function planFor(defId: string, unitId: string, f: ReviewLinkFacts): Plan {
  const fixing = f.decide === 'fix' || f.decide === 'both';
  switch (defId) {
    case REVIEW_DECIDE_STEP:
      return f.findings === 0
        ? close(unitId, REVIEW_LINK_END.clean, 'the review has no findings')
        : null;
    case 'fix':
      if (fixing) return null;
      if (f.decide === 'post') return skip(unitId, defId, 'review-link: post only, no fixes');
      return close(
        unitId,
        REVIEW_LINK_END.declined,
        f.foreignAnswer ? 'answer not in the options' : 'the human chose to do nothing',
      );
    case REVIEW_PUSH_STEP:
      return f.decide === 'post' ? skip(unitId, defId, 'review-link: post only, no push') : null;
    case 'final-gate':
      if (f.decide === 'post')
        return skip(unitId, defId, 'review-link: post only, nothing to push');
      if (f.push === 'send') return null;
      if (f.decide === 'both')
        return skip(unitId, defId, 'review-link: fixes not sent, the summary is still posted');
      return close(unitId, REVIEW_LINK_END.notSent, 'fixes stay in the copy, not sent');
    default:
      return null;
  }
}

/**
 * Действие сценария `review-link` до общего порядка `next`: первый незакрытый шаг по порядку и
 * его правило. Не этот сценарий или шаг без правила — `null`.
 */
export function reviewLinkNext(
  state: TaskFoldState,
  scenario: Scenario,
  view: UnitView,
): NextAction | null {
  if (!isReviewLink(state)) return null;
  const facts = reviewLinkFacts(state, view);
  for (const def of topoOrder(scenario)) {
    if (satisfied(view, scenario, def)) continue;
    return planFor(def.id, view.unitId, facts);
  }
  return null;
}

/** Единица закрыта решением человека или чистым ревью — конец задачи не провал. */
export function reviewLinkClosedByDecision(state: TaskFoldState, unitId: string): boolean {
  if (!isReviewLink(state) || state.units[unitId]?.state !== 'closed') return false;
  const f = reviewLinkFacts(state, unitView(state, unitId));
  if (latest(unitView(state, unitId), 'review')?.rec.state !== 'done') return false;
  if (f.findings === 0) return true;
  if (f.decide === 'none' || f.foreignAnswer) return true;
  return f.decide === 'fix' && f.push === 'keep';
}
