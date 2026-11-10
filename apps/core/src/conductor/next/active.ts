import { ASK_PRESET } from '@agentdeck/contracts/core/ask';
import { CORE_STEP_KINDS, type Scenario, type StepDef } from '@agentdeck/contracts/core/scenario';
import type { AskRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { CONDUCTOR_QUESTIONS, answerKey, askLangOf, labelOf, optionsOf } from './answers.ts';
import {
  END_REASON,
  type Attempt,
  type NextAction,
  type NextInput,
  type UnitView,
} from './next.types.ts';
import { loginAnswerAction } from './login-answer.ts';
import { overTokens, pendingSwitch, stepTokens, tokenLimit, windowAction } from './window.ts';

/**
 * Суд над идущей попыткой шага (02:41-51): срок, красная проверка, конец хода без `step_done`,
 * вопрос человеку, предел кругов. Возвращает действие или `wait` с причиной — порядок проверок
 * и есть приоритет: остановка сильнее срока, срок сильнее напоминания.
 */

const CORE_KINDS: ReadonlySet<string> = new Set(CORE_STEP_KINDS);
/** Напоминаний на шаг (F08): после третьего исход выводится по git и записям. */
export const REMINDER_CAP = 3;

export const isCoreKind = (def: StepDef): boolean => CORE_KINDS.has(def.kind);

/** Шаг ждёт места сеанса (этап 11, P141): ждать освобождения, а не запускать снова. */
function seatWait(input: NextInput, stepId: string): NextAction | null {
  const why = input.seats?.[stepId];
  return why === undefined ? null : { kind: 'wait', reason: `session seat: ${why}` };
}

/** Вопросы по ключу в порядке журнала (ключи — UUIDv7, порядок вставки сохранён). */
export function asksBy(
  state: TaskFoldState,
  match: (a: AskRecord) => boolean,
): (AskRecord & { askId: string })[] {
  return Object.entries(state.asks)
    .filter(([, a]) => match(a))
    .map(([askId, a]) => ({ ...a, askId }));
}

export const roundCapKey = (unitId: string, defId: string, round: number): string =>
  `round-cap:${unitId}:${defId}:${round}`;
export const budgetKey = (stepId: string, extensions: number): string =>
  `budget:${stepId}:${extensions}`;

/** Сколько кругов сверх `roundCap` человек уже дал этому шагу сценария («ещё один круг»). */
export function extraRounds(state: TaskFoldState, unitId: string, defId: string): number {
  const prefix = `round-cap:${unitId}:${defId}:`;
  return asksBy(
    state,
    (a) => a.dedupe?.startsWith(prefix) === true && answerKey('roundCap', a.answer) === 'more',
  ).length;
}

/**
 * Следующий круг шага сценария или точка 6 (G14). `capStep` — шаг ещё идёт, ему сначала
 * `round-cap`; ответ на открытый вопрос того же круга читается здесь же.
 */
export function nextRound(
  state: TaskFoldState,
  unitId: string,
  def: StepDef,
  round: number,
  stepId: string,
  capStep: boolean,
  go: NextAction,
): NextAction {
  if (round <= def.roundCap + extraRounds(state, unitId, def.id)) return go;
  const dedupe = roundCapKey(unitId, def.id, round);
  const ask = asksBy(state, (a) => a.dedupe === dedupe).pop();
  if (!ask) {
    const lang = askLangOf(state);
    return {
      kind: 'raise',
      point: 6,
      stepId,
      dedupe,
      question: CONDUCTOR_QUESTIONS.roundCap(lang, def, def.roundCap),
      options: optionsOf('roundCap', lang),
      recommendation: labelOf('roundCap', lang, 'stop'),
      capStep,
    };
  }
  const key = answerKey('roundCap', ask.answer);
  if (key === 'cancel') {
    return { kind: 'cancel-task', reason: `round-cap: ${def.id} — human cancel` };
  }
  if (key === 'stop') {
    return {
      kind: 'stop-step',
      stepId,
      reason: `${END_REASON.roundCap}: ${def.id} round ${round}`,
    };
  }
  return { kind: 'wait', reason: `round-cap ${dedupe}: ${ask.state}` };
}

function overBudget(
  input: NextInput,
  def: StepDef,
  { stepId, rec }: Attempt,
  spent: number,
): NextAction {
  const why = `${END_REASON.budget}: spent ${spent} of ${rec.budgetMs} ms`;
  const base = def.budget.minutes ? def.budget.minutes * 60_000 : rec.budgetMs;
  const extend = { kind: 'extend-budget', stepId, limitMs: rec.budgetMs + base } as const;
  if (def.overBudget === 'stop') return { kind: 'stop-step', stepId, reason: why };
  if (def.overBudget === 'once-more') {
    return rec.extensions === 0 ? extend : { kind: 'stop-step', stepId, reason: why };
  }
  const dedupe = budgetKey(stepId, rec.extensions);
  const ask = asksBy(input.state, (a) => a.dedupe === dedupe).pop();
  if (!ask) {
    const lang = askLangOf(input.state);
    return {
      kind: 'raise',
      point: 7,
      stepId,
      dedupe,
      question: CONDUCTOR_QUESTIONS.budgetTime(lang, def, Math.round(spent / 60_000)),
      options: optionsOf('budget', lang),
      recommendation: labelOf('budget', lang, 'stop'),
      capStep: false,
    };
  }
  const key = answerKey('budget', ask.answer);
  if (key === 'more') return extend;
  if (key === 'stop') return { kind: 'stop-step', stepId, reason: why };
  return { kind: 'wait', reason: `budget ask ${ask.state}` };
}

/** Шаг ждёт человека: ответ на его последний вопрос решает, как он выходит из ожидания. */
function waitingHuman(input: NextInput, def: StepDef, att: Attempt): NextAction {
  const mine = asksBy(input.state, (a) => a.stepId === att.stepId);
  if (mine.some((a) => a.state === 'open')) return { kind: 'wait', reason: 'human point open' };
  const last = mine.pop();
  if (!last || last.answer === undefined) return { kind: 'wait', reason: 'ask closed unanswered' };
  if (last.source === 'budget' && last.dedupe?.startsWith('exhausted:') === true) {
    // Исчерпанный маршрут: «ждать» — шаг в работе, но окно держит его до `clear-exhausted`;
    // вариант `model:`/`cli:` (P169) — правка задачи кликом, основание — этот вопрос.
    if (answerKey('exhausted', last.answer) === 'stop')
      return { kind: 'stop-step', stepId: att.stepId, reason: `${END_REASON.budget}: human stop` };
    const override = pendingSwitch(input.state, last.answer);
    return {
      kind: 'answered',
      stepId: att.stepId,
      askId: last.askId,
      ...(override ? { override } : {}),
    };
  }
  if (last.source === 'login') {
    // Потерянный вход (P170): то же правило, что у шага без сессии (`login-answer.ts`).
    return (
      loginAnswerAction(input.state, att) ?? {
        kind: 'answered',
        stepId: att.stepId,
        askId: last.askId,
      }
    );
  }
  if (last.source === 'budget') {
    // Ответ на срок: продление — то же, что `once-more`; «остановить» — шаг кончается.
    return answerKey('budget', last.answer) === 'more'
      ? { kind: 'answered', stepId: att.stepId, askId: last.askId }
      : { kind: 'stop-step', stepId: att.stepId, reason: `${END_REASON.budget}: human stop` };
  }
  if (def.kind === 'ask-human') {
    return { kind: 'close-human-step', stepId: att.stepId, askId: last.askId };
  }
  return { kind: 'answered', stepId: att.stepId, askId: last.askId };
}

/** Применённый `end-chat` этого шага (`command.applied`, исход несёт `stepId`) — его `cmdId`. */
export function endChatOf(state: TaskFoldState, stepId: string): string | undefined {
  for (const [cmdId, c] of Object.entries(state.commands)) {
    if (c.kind !== 'end-chat' || c.status !== 'applied') continue;
    const o = c.outcome as { stepId?: unknown } | undefined;
    if (o?.stepId === stepId) return cmdId;
  }
  return undefined;
}

/**
 * Шаг чата (этап 10): открыт между ходами. Конец хода — ждать человека (ни напоминания, ни вывода
 * исхода: молчание модели после ответа — норма разговора); ход человека доставляет `run.ts`
 * (`message-to-step`). Закрывает только `end-chat` или отмена; сеанс, умерший сам, — остановка.
 */
function chatAction(input: NextInput, def: StepDef, att: Attempt): NextAction {
  const { stepId, rec } = att;
  const cmdId = endChatOf(input.state, stepId);
  if (cmdId) return { kind: 'close-chat', stepId, cmdId };
  if (rec.state === 'waiting-human') return waitingHuman(input, def, att);
  const fact = input.live[stepId];
  const held = windowAction(input.state, def, att, fact, input.windows?.[stepId]);
  if (held) return held;
  if (!fact) return loginAnswerAction(input.state, att) ?? { kind: 'run-step', stepId };
  // Вопрос «ask» (этап 10, F2): один ход — его конец и есть ответ; шаг закрывает ядро, а не
  // `end-chat`. Раньше проверки конца сессии: CLI, вышедший сразу за ответом, — не обрыв.
  if (fact.turnEnd && input.state.created?.scenario.id === ASK_PRESET) {
    return { kind: 'close-ask', stepId };
  }
  if (fact.ended) {
    return { kind: 'stop-step', stepId, reason: `${END_REASON.chatSessionEnded}: no end-chat` };
  }
  return { kind: 'wait', reason: fact.turnEnd ? 'chat: waits for the human turn' : 'chat turn' };
}

export function activeAction(
  input: NextInput,
  scenario: Scenario,
  view: UnitView,
  att: Attempt,
): NextAction {
  const { state, live, workNowMs } = input;
  const { stepId, rec } = att;
  const def = scenario.steps.find((s) => s.id === rec.stepDefId);
  if (!def) return { kind: 'stop-step', stepId, reason: `${END_REASON.stopped}: unknown step` };
  if (rec.stops.length > 0) {
    return { kind: 'stop-step', stepId, reason: `${END_REASON.stopped}: ${rec.stops.join('; ')}` };
  }
  if (def.kind === 'chat') return chatAction(input, def, att);
  const win = input.windows?.[stepId];
  if (rec.state === 'queued') {
    if (isCoreKind(def)) return { kind: 'run-core-step', stepId };
    return (
      windowAction(state, def, att, undefined, win) ??
      seatWait(input, stepId) ?? { kind: 'run-step', stepId }
    );
  }
  if (rec.state === 'waiting-human') return waitingHuman(input, def, att);
  if (rec.state === 'round-capped') {
    const round = rec.round + 1;
    return nextRound(state, view.unitId, def, round, stepId, false, {
      kind: 'reenter-step',
      stepId,
      round,
      why: 'red',
    });
  }
  const spent = workNowMs - rec.workAtStart;
  if (rec.budgetMs > 0 && spent > rec.budgetMs) return overBudget(input, def, att, spent);
  if (!isCoreKind(def)) {
    const limit = tokenLimit(state, def, stepId, input.learnedTokens?.[stepId]);
    const used = stepTokens(state, stepId);
    if (limit !== null && used > limit) return overTokens(state, def, att, used, limit);
  }
  if (rec.state === 'checking') return { kind: 'post-step', stepId };
  // running
  if (rec.red) {
    const round = rec.round + 1;
    return nextRound(state, view.unitId, def, round, stepId, true, {
      kind: 'reenter-step',
      stepId,
      round,
      why: 'red',
    });
  }
  if (def.kind === 'ask-human') {
    // Ответ человека сам возвращает шаг в работу (`answer` → `answered`): закрыть по ответу, а не
    // спросить второй раз; открытый вопрос — ждать.
    const mine = asksBy(state, (a) => a.stepId === stepId);
    const done = mine.find((a) => a.answer !== undefined);
    if (done) return { kind: 'close-human-step', stepId, askId: done.askId };
    if (mine.some((a) => a.state === 'open')) return { kind: 'wait', reason: 'human point 8 open' };
  }
  if (isCoreKind(def)) return { kind: 'run-core-step', stepId };
  const fact = live[stepId];
  // Окно маршрута раньше напоминания: ход в отказавший маршрут ничего не даст (03:157, P116).
  const held = windowAction(state, def, att, fact, win);
  if (held) return held;
  const seat = seatWait(input, stepId);
  if (!fact) return loginAnswerAction(state, att) ?? seat ?? { kind: 'run-step', stepId };
  // Сеанс отдал место на вопросе человеку и ждёт его назад: ни напоминания, ни хода без места.
  if (seat && !fact.ended) return seat;
  // Просьба наблюдателя о паузе (`context-growth`, этап 8 F10) — до напоминания: напоминать
  // модели, чью сессию сейчас снимут, значит тратить ход. Паркуется только в безопасной точке
  // (граница хода), иначе ждём её; повтор шага начнёт новый разговор и запишет `continuation`.
  const parkAsked = state.sessions[fact.sessionId]?.parkAsked;
  if (parkAsked && !fact.ended) {
    if (fact.safe) return { kind: 'park-session', stepId, mode: 'soft', why: 'observer' };
    return { kind: 'wait', reason: `observer park (${parkAsked.signal}): not at a safe point` };
  }
  if (fact.turnEnd) {
    const turnSeq = fact.turnEnd.seq;
    if (rec.remindedTurns.includes(turnSeq)) {
      return { kind: 'wait', reason: `turn ${turnSeq} already reminded` };
    }
    if (rec.reminders < REMINDER_CAP) {
      return {
        kind: 'remind',
        stepId,
        sessionId: fact.sessionId,
        turnSeq,
        count: rec.reminders + 1,
      };
    }
    return { kind: 'derive-outcome', stepId };
  }
  if (fact.ended) return { kind: 'derive-outcome', stepId };
  return {
    kind: 'wait',
    reason: 'session working',
    ...(rec.budgetMs > 0 ? { untilWorkMs: rec.workAtStart + rec.budgetMs } : {}),
  };
}
