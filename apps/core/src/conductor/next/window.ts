import type { StepClass, WindowDecision } from '@agentdeck/contracts/core/economy';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { routeWait } from '../../economy/window/index.ts';
import type { AskRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { usageOf } from '../../journal/reduce/fold-view.ts';
import { budgetTokens } from '../../economy/cost.ts';
import { tokenScopeOf } from '../../economy/budget/index.ts';
import { STEP_BUDGET_SCOPE } from '../../journal/reduce/stage4.ts';
import {
  CONDUCTOR_QUESTIONS,
  answerKey,
  askLangOf,
  labelOf,
  optionsOf,
  switchAnswerOf,
} from './answers.ts';
import {
  END_REASON,
  type Attempt,
  type LiveStepFact,
  type NextAction,
  type StepWindow,
} from './next.types.ts';

/**
 * Окно маршрута и токены шага в суде `next` (03:157-160, P116, P122, G10). Вердикт окна выносит
 * только `economy/window` (зона L); здесь — что из него следует для попытки: ждать в безопасной
 * точке, снять сессию мягко, позвать человека точкой 7, когда маршрут исчерпан и уйти некуда.
 */

/** Класс шага для таблицы окна: всё, что не ревью и не фикс, — работа. */
export function stepClassOf(kind: StepDef['kind']): StepClass {
  switch (kind) {
    case 'review':
      return 'review';
    case 'fix':
    case 'answer-reviewers':
      return 'fix';
    case 'final-gate':
    case 'check':
      return 'final-gate';
    case 'publish':
      return 'publish';
    default:
      return 'work';
  }
}

export const exhaustedKey = (routeId: string, stepId: string): string =>
  `exhausted:${routeId}:${stepId}`;
export const tokenBudgetKey = (stepId: string, limit: number): string =>
  `budget-tokens:${stepId}:${limit}`;
/** Область строки `budget.state` для токенов шага — та же, что пишет `budgetState` (E). */
export const tokenScope = (stepId: string): string => tokenScopeOf(`${STEP_BUDGET_SCOPE}${stepId}`);

export interface WindowGate {
  wait: boolean;
  routeId: string;
  resumeAt: number | null;
  verdicts: string[];
  exhausted: boolean;
}

/** Ждёт ли попытка окна своего маршрута; `null` — окно не судит (нет маршрута или фактов). */
export function windowGate(win: StepWindow | undefined, def: StepDef): WindowGate | null {
  if (!win) return null;
  const got = routeWait(win.decisions as WindowDecision[], stepClassOf(def.kind));
  if (!got.wait) return null;
  return {
    wait: true,
    routeId: win.routeId,
    resumeAt: got.resumeAt,
    verdicts: got.by.map((d) => `${d.limitKind}:${d.verdict}`),
    exhausted: got.by.some((d) => d.verdict === 'exhausted'),
  };
}

const waitOn = (g: WindowGate, what: string, stepId?: string): NextAction => ({
  kind: 'wait',
  reason: `window ${g.routeId} ${g.verdicts.join(',')}: ${what}`,
  ...(g.resumeAt === null ? {} : { untilWallMs: g.resumeAt }),
  ...(stepId === undefined ? {} : { window: { stepId, routeId: g.routeId } }),
});

/**
 * Вариант перевода точки 7 (`tier.offers`, P169), ещё не применённый: `model:<id>` — правка
 * модели, `cli:<id>` — правка CLI задачи. Другой текст, или последняя правка задачи по этому полю
 * уже несёт это значение, — `null`. Что вариант был среди предложенных, сверяет исполнитель по
 * строке вопроса (`conductor/run/perform.ts`).
 */
export function pendingSwitch(
  state: TaskFoldState,
  answer: string | undefined,
): { field: 'model' | 'adapter'; value: string } | null {
  const asked = switchAnswerOf(answer);
  if (!asked) return null;
  const last = state.overrides.filter((o) => o.scope === 'task' && o.field === asked.field).at(-1);
  return last?.value === asked.value ? null : asked;
}

function asksOf(state: TaskFoldState, dedupe: string): (AskRecord & { askId: string })[] {
  return Object.entries(state.asks)
    .filter(([, a]) => a.dedupe === dedupe)
    .map(([askId, a]) => ({ ...a, askId }));
}

/**
 * Попытка шага модели на маршруте, который ждёт: живая сессия снимается мягко в безопасной точке
 * (сеть, отказ, тесное окно — P116, 03:157); без сессии — ждать сброса или факта. Исчерпанный
 * маршрут (402) без другого годного маршрута — точка 7 один раз на шаг и маршрут (P122, G11).
 */
export function windowAction(
  state: TaskFoldState,
  def: StepDef,
  att: Attempt,
  fact: LiveStepFact | undefined,
  win: StepWindow | undefined,
): NextAction | null {
  const gate = windowGate(win, def);
  if (!gate) return null;
  if (fact && !fact.ended) {
    if (fact.safe) return { kind: 'park-session', stepId: att.stepId, mode: 'soft', why: 'window' };
    return waitOn(gate, 'not at a safe point');
  }
  // Окно держит маршрут, а не уводит шаг: у начатой задачи годные маршруты — только варианты
  // клика (P169), у новой отказ `tier` значит, что уйти некуда. Точка 7 — при любом их числе.
  if (gate.exhausted) {
    const dedupe = exhaustedKey(gate.routeId, att.stepId);
    const ask = asksOf(state, dedupe).pop();
    if (!ask) {
      const lang = askLangOf(state);
      const offers = [...(win?.offers ?? [])];
      return {
        kind: 'raise',
        point: 7,
        stepId: att.stepId,
        dedupe,
        question: CONDUCTOR_QUESTIONS.exhausted(lang, gate.routeId, def, offers.length),
        options: [...optionsOf('exhausted', lang), ...offers],
        recommendation: labelOf('exhausted', lang, 'wait'),
        capStep: false,
      };
    }
    if (answerKey('exhausted', ask.answer) === 'stop')
      return {
        kind: 'stop-step',
        stepId: att.stepId,
        reason: `${END_REASON.budget}: route ${gate.routeId} exhausted, human stop`,
      };
    // Ответ отпустил шаг сам (`answer` → running): перевод кликом применяет исполнитель.
    const override = pendingSwitch(state, ask.answer);
    if (override) return { kind: 'answered', stepId: att.stepId, askId: ask.askId, override };
  }
  // Живой сессии нет (снята или не начиналась): задача ждёт окно — `waiting-window`.
  return waitOn(gate, fact ? 'session parked' : 'step waits', att.stepId);
}

/** Токены бюджета шага (G10): вход + запись кэша + выход по свёртке v7. */
export function stepTokens(state: TaskFoldState, stepId: string): number {
  return budgetTokens(usageOf(state, `step:${stepId}`));
}

/** Предел токенов шага: продление человека, иначе сценарий, иначе выученный (вход судьи). */
export function tokenLimit(
  state: TaskFoldState,
  def: StepDef,
  stepId: string,
  learned: number | undefined,
): number | null {
  const row = state.budgets[tokenScope(stepId)];
  if (row && row.limit !== null) return row.limit;
  return def.budget.tokens ?? learned ?? null;
}

/** Перерасход токенов: то же правило `overBudget`, что у минут; точка 7 — по своему ключу. */
export function overTokens(
  state: TaskFoldState,
  def: StepDef,
  att: Attempt,
  spent: number,
  limit: number,
): NextAction {
  const { stepId } = att;
  const why = `${END_REASON.budget}: spent ${spent} of ${limit} tokens`;
  const extended = state.budgets[tokenScope(stepId)] !== undefined;
  const base = def.budget.tokens ?? limit;
  const extend = { kind: 'extend-tokens', stepId, limitTokens: limit + base } as const;
  if (def.overBudget === 'stop') return { kind: 'stop-step', stepId, reason: why };
  if (def.overBudget === 'once-more')
    return extended ? { kind: 'stop-step', stepId, reason: why } : extend;
  const dedupe = tokenBudgetKey(stepId, limit);
  const ask = asksOf(state, dedupe).pop();
  if (!ask) {
    const lang = askLangOf(state);
    return {
      kind: 'raise',
      point: 7,
      stepId,
      dedupe,
      question: CONDUCTOR_QUESTIONS.budgetTokens(lang, def, spent, limit),
      options: optionsOf('budget', lang),
      recommendation: labelOf('budget', lang, 'stop'),
      capStep: false,
    };
  }
  const key = answerKey('budget', ask.answer);
  if (key === 'more') return extend;
  if (key === 'stop') return { kind: 'stop-step', stepId, reason: why };
  return { kind: 'wait', reason: `token budget ask ${ask.state}` };
}
