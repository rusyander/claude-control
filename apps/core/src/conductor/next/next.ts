import type { Scenario, StepDef } from '@agentdeck/contracts/core/scenario';
import type { TaskFoldState, UnitRecord } from '../../journal/reduce/reduce.types.ts';
import { activeAction, extraRounds, nextRound } from './active.ts';
import {
  afterPublish,
  endCode,
  hasBlocking,
  latest,
  noOutcomeCount,
  reviewOf,
  satisfied,
  staleBy,
  topoOrder,
  unitView,
} from './attempts.ts';
import {
  END_REASON,
  type NextAction,
  type NextInput,
  type NextStepDecision,
  type UnitView,
} from './next.types.ts';
import { integrationHold, integrationRoundOf, isIntegrationUnit } from '../gates/integrated.ts';
import { xlParentNext } from '../split/xl-wait.ts';
import { leadGate } from './lead-gate.ts';
import { publishStep, resolveConflict, tailStep, unitEndEvent } from './publish.ts';
import { reviewLinkClosedByDecision, reviewLinkNext } from './review-link.ts';
import { trackerWriteHold } from './tracker-write.ts';

/**
 * Единственный судья класса `next` (P01, 02 §Conductor loop): свёртка журнала + сценарий + живые
 * факты этого процесса → одно действие. Чистая функция: тот же вход — то же действие, поэтому
 * перезапуск ядра (`resume()` журнала) и пауза/продолжение дают одно и то же решение (P11).
 *
 * Единицы смотрятся по порядку создания; первая, которой есть что делать, получает действие —
 * так единицы без связи идут параллельно (исполнитель зовёт `next` снова после каждого действия).
 */

/** Единица дальше не работает: конец машины. */
const UNIT_SETTLED = new Set(['done', 'closed', 'conditional']);
/** Единица, у которой есть шаги: работа, публикация и хвост после неё (машина `core/states.ts`). */
const UNIT_WORKING = new Set(['running', 'ready-to-publish', 'published', 'answering']);
/** Потребитель начинает работу, когда предшественник готов к публикации или дальше (P76). */
const UNIT_PREDECESSOR_OK = new Set([
  ...UNIT_SETTLED,
  'ready-to-publish',
  'published',
  'answering',
]);
const ALL_SATISFIED = 'all steps satisfied';

/**
 * Стоп-сигнал по любой попытке единицы (защищённый корень, F-061). Дорога пишет его в конце
 * сессии — шаг к тому мигу уже мог закончиться `done`, но единица дальше не идёт.
 */
function stopOf(view: UnitView): string | null {
  for (const list of view.byDef.values()) {
    for (const a of list)
      if (a.rec.stops.length > 0) return `${END_REASON.stopped}: ${a.rec.stops.join('; ')}`;
  }
  return null;
}

/** Единица кончилась провалом: последняя попытка какого-то шага сценария — `failed`. */
export function unitFailed(state: TaskFoldState, unitId: string): string | null {
  const view = unitView(state, unitId);
  const stopped = stopOf(view);
  if (stopped) return stopped;
  for (const [defId] of view.byDef) {
    const last = latest(view, defId);
    if (last?.rec.state === 'failed' && endCode(last.rec) !== END_REASON.superseded) {
      return `${defId}: ${last.rec.reason ?? 'failed'}`;
    }
  }
  return null;
}

function failedDef(
  state: TaskFoldState,
  view: UnitView,
  def: StepDef,
  stepId: string,
  round: number,
): NextAction {
  const last = latest(view, def.id)!;
  if (endCode(last.rec) !== END_REASON.noOutcome) {
    return { kind: 'end-unit', unitId: view.unitId, event: 'close', reason: `failed ${def.id}` };
  }
  // Без исхода (G14): одна свежая попытка; вторая без исхода — точка 6 того же круга.
  const go: NextAction = {
    kind: 'start-step',
    unitId: view.unitId,
    stepDefId: def.id,
    round,
    why: 'no-outcome',
  };
  const extra = extraRounds(state, view.unitId, def.id);
  if (noOutcomeCount(view, def.id) <= 1 + extra) return go;
  // Предел ниже круга: `nextRound` задаёт вопрос или читает ответ на него, не пропускает.
  const shut = { ...def, roundCap: round - 1 - extra };
  const capped = nextRound(state, view.unitId, shut, round, stepId, false, go);
  // Ответ «остановить» на провалившийся шаг: шаг уже кончился — кончается единица.
  return capped.kind === 'stop-step'
    ? { kind: 'end-unit', unitId: view.unitId, event: 'close', reason: capped.reason }
    : capped;
}

/** Следующий шаг сценария единицы без идущей попытки. */
function unitNext(
  input: NextInput,
  scenario: Scenario,
  view: UnitView,
  unit: UnitRecord,
): NextAction {
  const { state } = input;
  const unitId = view.unitId;
  const stopped = stopOf(view);
  if (stopped) return { kind: 'end-unit', unitId, event: 'close', reason: stopped };
  const conflict = resolveConflict(state, scenario, view, unit);
  if (conflict) return conflict;
  // Ревью по ссылке (этап 10, F8): после ревью шаги выбирает ответ человека.
  const byDecision = reviewLinkNext(state, scenario, view);
  if (byDecision) return byDecision;
  // Интеграция после зелёного (Q-1): голова единицы сдвинулась — новый круг ворот.
  const reround = integrationRoundOf(state, unitId);
  if (reround) return reround;
  const publishTail = afterPublish(scenario);
  for (const def of topoOrder(scenario)) {
    if (publishTail.has(def.id) && def.kind !== 'publish') {
      // Хвост после публикации: «опубликовано», «отвечает» или пропуск ответа без нитей.
      const tail = tailStep(state, view, unit, def);
      // Интеграция своего MR не открывает: её «опубликовано» — только после всех её шагов, иначе
      // ревью общего диффа нового круга (Q-1) стояло бы за ранним концом хвоста.
      const ends = tail?.kind === 'end-unit' && !isIntegrationUnit(unit);
      if (tail && (ends || !satisfied(view, scenario, def))) return tail;
    }
    if (satisfied(view, scenario, def)) continue;
    const last = latest(view, def.id);
    // Форма задачи ведущего (этап 11): шаг, которого ещё не было, — пропуск по карточке и классу.
    // Пропущенный шаг, устаревший по зависимости (второе ревью после нового круга ревью), судится
    // формой заново: иначе он пошёл бы как устаревшая попытка мимо правила, что его пропустило.
    const shaped =
      last && last.rec.state !== 'skipped' ? null : leadGate(state, def, unitId, input.contour);
    if (shaped) return shaped;
    const round = last ? last.rec.round + 1 : 0;
    if (def.kind === 'publish') {
      const published = publishStep(input, scenario, view, unit, def);
      if (published) return published;
    }
    if (last?.rec.state === 'failed') return failedDef(state, view, def, last.stepId, round);
    if (def.kind === 'fix') {
      const review = reviewOf(scenario, def, view);
      const r = review ? latest(view, review.id) : undefined;
      if (r && !hasBlocking(r.rec)) {
        return {
          kind: 'skip-step',
          unitId,
          stepDefId: def.id,
          round: r.rec.round,
          basis: 'core',
          reason: `${END_REASON.cleanReview}: review ${r.stepId} has no blocking findings`,
        };
      }
      return {
        kind: 'start-step',
        unitId,
        stepDefId: def.id,
        round: r?.rec.round ?? 0,
        why: 'fix',
      };
    }
    if (!last) return { kind: 'start-step', unitId, stepDefId: def.id, round: 0, why: 'first' };
    // Попытка устарела: ревью после правки — новый круг под пределом (G14), остальные — заново.
    const by = staleBy(view, scenario, def, last);
    const go: NextAction = {
      kind: 'start-step',
      unitId,
      stepDefId: def.id,
      round,
      why: def.kind === 'review' ? 'review-round' : 'stale',
    };
    if (def.kind === 'review' && by !== null && !def.after.includes(by)) {
      const capped = nextRound(state, unitId, def, round, last.stepId, false, go);
      return capped.kind === 'stop-step'
        ? { kind: 'end-unit', unitId, event: 'close', reason: capped.reason }
        : capped;
    }
    return go;
  }
  const event = unitEndEvent(unit, publishTail.size > 0);
  return {
    kind: 'end-unit',
    unitId,
    event,
    reason:
      event === 'close' || event === 'ready' ? ALL_SATISFIED : `all steps satisfied (${event})`,
  };
}

type Wait = Extract<NextAction, { kind: 'wait' }>;

function earlier(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Слияние ожиданий: причина первого ждущего, сроки — ближайшие по каждым часам. */
function sooner(prev: Wait | null, next: Wait): Wait {
  if (!prev) return next;
  const work = earlier(prev.untilWorkMs, next.untilWorkMs);
  const wall = earlier(prev.untilWallMs, next.untilWallMs);
  // Задача ждёт окна, только когда окна ждут все ждущие единицы: иначе она ждёт другого.
  const window = prev.window && next.window ? prev.window : undefined;
  return {
    kind: 'wait',
    reason: prev.reason,
    ...(work === undefined ? {} : { untilWorkMs: work }),
    ...(wall === undefined ? {} : { untilWallMs: wall }),
    ...(window ? { window } : {}),
  };
}

function predecessorsSettled(state: TaskFoldState, unit: UnitRecord): boolean {
  return unit.after.every((id) => UNIT_PREDECESSOR_OK.has(state.units[id]?.state ?? ''));
}

/** Пауза (G10): каждая живая сессия снимается — сразу (`now`) или в безопасной точке. */
function paused(input: NextInput): NextAction {
  for (const [stepId, fact] of Object.entries(input.live)) {
    if (fact.ended) continue;
    if (input.state.pause?.now) return { kind: 'park-session', stepId, mode: 'tree', why: 'pause' };
    if (fact.safe) return { kind: 'park-session', stepId, mode: 'soft', why: 'pause' };
    return { kind: 'wait', reason: `pause: step ${stepId} not at a safe point` };
  }
  return { kind: 'wait', reason: 'paused' };
}

function taskEnd(
  state: TaskFoldState,
  scenario: Scenario,
  units: [string, UnitRecord][],
): NextAction {
  // Единица 0 оценки закрывается делением (G6): после принятого деления она не итог задачи.
  const split = Object.values(state.splits).some(
    (s) => s.state !== 'proposed' && s.state !== 'refused',
  );
  const counted = units.filter(([, u]) => !(split && u.splitId === null));
  const publishes = afterPublish(scenario).size > 0;
  for (const [unitId, unit] of counted) {
    const failed = unitFailed(state, unitId);
    if (failed) return { kind: 'fail-task', reason: `unit ${unitId}: ${failed}` };
    // Сценарий с публикацией, а единица закрыта до «готово» (человек остановил круги) — не сдана.
    if (publishes && unit.state === 'closed' && !reviewLinkClosedByDecision(state, unitId)) {
      return { kind: 'fail-task', reason: `unit ${unitId}: closed before ready to publish` };
    }
  }
  // Комментарий назад в тикет решается (пункт 9): конец ждёт ответа и записи (W2-D, P166).
  const held = trackerWriteHold(state);
  if (held) return { kind: 'wait', reason: held };
  return { kind: 'finish-task' };
}

/**
 * Оценка (G5/G6): до запуска идут только точка деления (план, деление; без них — разбор) и шаги,
 * от которых она зависит. Остальное сценария — после запуска. `null` — точки деления нет.
 */
export function estimateScope(scenario: Scenario): Scenario | null {
  // То же правило, что `isSplitPoint` деления (D, `split/flow.ts`); судья `next` чистый и не тянет
  // модуль деления с его вводом-выводом — совпадение держит next.test.ts по каждому пресету.
  const hasPlan = scenario.steps.some((s) => s.kind === 'plan' || s.kind === 'split');
  const points = scenario.steps.filter(
    (d) => d.kind === 'plan' || d.kind === 'split' || (d.kind === 'intake' && !hasPlan),
  );
  if (points.length === 0) return null;
  const byId = new Map(scenario.steps.map((d) => [d.id, d]));
  const keep = new Set<string>();
  const visit = (def: StepDef): void => {
    if (keep.has(def.id)) return;
    keep.add(def.id);
    for (const id of def.after) {
      const dep = byId.get(id);
      if (dep) visit(dep);
    }
  };
  points.forEach(visit);
  return { ...scenario, steps: scenario.steps.filter((d) => keep.has(d.id)) };
}

/** Оценка — шаги до точки деления; дальше решает деление (D), а не `next`. */
function estimating(input: NextInput): NextAction {
  const scope = estimateScope(input.scenario);
  if (!scope) return { kind: 'wait', reason: 'estimate: the scenario has no split point' };
  const action = decide({ ...input, scenario: scope }, true);
  // Все шаги оценки сделаны: единица 0 не кончается — её продолжит запуск (G6). Провал или
  // стоп-сигнал закрывают её как обычно.
  const allDone =
    action.kind === 'end-unit' && (action.event === 'ready' || action.reason === ALL_SATISFIED);
  return allDone
    ? { kind: 'wait', reason: 'estimate: split point done, awaiting the split decision' }
    : action;
}

function decide(input: NextInput, scoped = false): NextAction {
  const { state, scenario } = input;
  if (state.ended !== null) return { kind: 'wait', reason: `task ended ${state.ended}` };
  if (state.task === 'paused') return paused(input);
  if (state.task === 'estimating' && !scoped) return estimating(input);
  // Ждущая окна задача судится как идущая: окно открылось или человек перевёл её — она идёт.
  if (state.task !== 'running' && state.task !== 'estimating' && state.task !== 'waiting-window')
    return { kind: 'wait', reason: `task ${state.task}` };
  const units = Object.entries(state.units).sort((a, b) => a[1].createdSeq - b[1].createdSeq);
  if (units.length === 0) return { kind: 'create-unit' };
  let wait: Wait | null = null;
  for (const [unitId, unit] of units) {
    let action: NextAction;
    if (unit.state === 'planned') {
      if (!predecessorsSettled(state, unit)) continue;
      action = { kind: 'start-unit', unitId };
    } else if (UNIT_WORKING.has(unit.state)) {
      const view = unitView(state, unitId);
      action = view.active
        ? activeAction(input, scenario, view, view.active)
        : unitNext(input, scenario, view, unit);
      // Интеграция не уходит в конец, пока её единицы публикуются (Q-1, `gates/integrated.ts`).
      const hold =
        action.kind === 'end-unit' && action.event === 'published'
          ? integrationHold(state, unitId)
          : null;
      if (hold) action = { kind: 'wait', reason: hold };
    } else continue;
    if (action.kind !== 'wait') return action;
    // Ближайший срок среди ждущих единиц — исполнитель ставит таймер на него (рабочее время и
    // стена — разные часы, ближайший берётся по каждым).
    wait = sooner(wait, action);
  }
  if (units.every(([, u]) => UNIT_SETTLED.has(u.state))) {
    // Родитель XL (Q-2 s11): его итог — дети; кончается, когда кончились все они.
    if (input.children) return xlParentNext(input.children, input.nowMs ?? 0);
    return taskEnd(state, scenario, units);
  }
  return wait ?? { kind: 'wait', reason: 'units blocked by predecessors' };
}

export function decideNext(input: NextInput): NextStepDecision {
  const action = decide(input);
  const reasons = [action.kind === 'wait' ? action.reason : action.kind];
  if ('reason' in action && action.kind !== 'wait') reasons.push(action.reason);
  return { action, reasons, inputs: [input.state.seq] };
}

export { REMINDER_CAP } from './active.ts';
