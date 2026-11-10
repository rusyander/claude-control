import type { TaskEvent } from '@agentdeck/contracts/core/states';
import { continuationDecisionBody, tierDecisionBody } from '../../economy/records.ts';
import type { TierDecision } from '../../economy/tier.types.ts';
import { readHumanLedger } from '../human/ledger.ts';
import { STEP_BUDGET_SCOPE } from '../../journal/reduce/stage4.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { END_REASON, type NextAction } from '../next/next.types.ts';
import { stepTokens, tokenScope } from '../next/window.ts';
import { decideRouting, routeStep, type StepRouting } from '../scenario/index.ts';
import { dropSeat, seatAskOf, takeSeat } from '../schedule/lease.ts';
import { runCoreStep } from './core-step.ts';
import * as hook from './hooks.ts';
import {
  endSession,
  failStep,
  settle,
  startStep,
  stepCtx,
  stepEnded,
  stepMove,
  taskMove,
  unitCtx,
  unitMove,
  type PerformCtx,
} from './moves.ts';
import type { StepCtx } from './run.types.ts';

export { defOf, stepCtx, unitCtx, type PerformCtx } from './moves.ts';

/**
 * Исполнение одного действия `next` (02:39-40): строки журнала, крючки зон, сессии. Здесь ничего
 * не решается — каждое «если» ниже только проверяет, что машина состояний ещё допускает событие
 * (повтор после перезапуска не должен писать второй переход). Примитивы — `moves.ts`, шаг ядра —
 * `core-step.ts`.
 */
/** Строка журнала отказа дороги открыть сессию шага: subject — шаг, detail — «k/N: причина». */
export const SESSION_REFUSED_SIGNAL = 'session-refused';
/**
 * Столько отказов подряд — и шаг кончается без исхода (G14): свежая попытка, затем точка 6.
 * Отказ дороги обычно не проходит сам (модель не названа, совместимость, ключ), а молчаливое
 * ожидание прятало его от человека; три — запас на случайный сбой запуска процесса.
 */
export const SESSION_REFUSALS_CAP = 3;

/** Текст напоминания модели (02:45): один на конец хода, короткий, без нового задания. */
export const REMINDER_TEXT =
  'Your turn ended without step_done or blocker. Call step_done with the outcome of this step, ' +
  'or blocker if you cannot continue.';

/** Минимум, по которому модель найдёт свой шаг, — когда частей брифа нет. */
export function stepLine(s: StepCtx): string {
  return `Step «${s.def.title}» (${s.def.kind}), stepId ${s.stepId}, round ${s.round}. When done call step_done with this stepId.`;
}

export function briefText(s: StepCtx, sections: { text: string }[]): string {
  if (sections.length > 0) return sections.map((x) => x.text).join('\n\n');
  // Бриф собирает зона A (`preStep`); без неё — минимум, по которому модель найдёт свой шаг.
  return stepLine(s);
}

async function runStep(ctx: PerformCtx, stepId: string): Promise<void> {
  const fresh = ctx.task.state.steps[stepId]?.state === 'queued';
  stepMove(ctx.task, stepId, 'start');
  const s = stepCtx(ctx, stepId);
  if (!s) return;
  // Маршрут решает зона A. Первый запуск шага пишет решения `tier`/`continuation` в журнал;
  // повторный запуск того же шага (перезапуск ядра, продолжение после паузы) берёт их чистым
  // судом заново — второй пары строк на один шаг журнал не получает. Окна маршрутов (этап 5) —
  // вход судьи `tier`: держащий маршрут он пропускает, другой годный берёт с причиной (P110).
  const where = { stepId, unitId: s.unitId, def: s.def };
  const env = ctx.deps.economy?.routingEnv?.(ctx.task);
  const routing = fresh
    ? routeStep(ctx.task, where, env)
    : decideRouting(ctx.task.state, where, env);
  if (!routing.tier.ok) {
    await failStep(ctx, stepId, `${END_REASON.noRoute}: ${routing.tier.reasons.join('; ')}`);
    return;
  }
  if (!fresh && ctx.task.state.observerParks[stepId]) journalReroute(ctx.task, where, routing);
  else if (!fresh) journalMoved(ctx.task, where, routing);
  s.routing = routing;
  // Место сеанса (этап 11, P141) — до крючков брифа: ждущий шаг не собирает бриф на каждом
  // пробуждении. Нет места — строка `schedule` с держателем, исполнитель спит до освобождения.
  const seats = ctx.deps.allocator;
  const ask = seatAskOf(ctx.task, s, routing.tier.route.id);
  if (seats && !(await takeSeat(ctx.task, seats, ask))) return;
  const pre = await hook.preStep(ctx.deps.hooks, s);
  if (!pre.verdict.ok) {
    await failStep(ctx, stepId, `${END_REASON.hook}: ${pre.verdict.code} ${pre.verdict.reason}`);
    return;
  }
  // Продолжение (03:150-155): тот же разговор возобновляет дорога (`spec.resume`); его процесс,
  // если он ещё жив под другой попыткой, сначала снимается мягко — два процесса на один разговор
  // CLI не держит.
  const cont = routing.continuation;
  if (cont?.mode === 'same-session') {
    for (const [other, l] of [...ctx.live])
      if (other !== stepId && l.sessionId === cont.sessionId) await endSession(ctx, other, 'soft');
  }
  // Бриф сверх бюджета — отказ шага с названными корзинами, а не обрезка (03:136).
  const over = ctx.deps.economy?.briefRefusal?.(ctx.task, s, pre.sections) ?? null;
  if (over) {
    await failStep(ctx, stepId, `${END_REASON.briefOverBudget}: ${over}`);
    return;
  }
  const refused = await ctx.openSession(s, pre.sections);
  if (refused === null) {
    ctx.refusals.delete(stepId);
    const opened = ctx.live.get(stepId)?.sessionId;
    if (seats && opened) seats.bind(ctx.task.taskId, stepId, opened);
    return;
  }
  // Отказ дороги места не держит: повтор шага встанет в очередь заново.
  if (seats) dropSeat(ctx.task, seats, stepId, 'session refused');
  if (refused.startsWith(END_REASON.briefOverBudget)) {
    await failStep(ctx, stepId, refused);
    return;
  }
  await sessionRefused(ctx, stepId, refused);
}

/**
 * Повтор шага, чья сессия кончилась при просьбе наблюдателя о паузе (`observerParks` свёртки,
 * этап 8 F10), пишет `continuation` (и `tier`, если маршрут или переходник сменился) — с числами,
 * по которым решено, иначе человек не видит, почему разговор начат заново. Строки несут `stepId`:
 * свёртка снимает ими метку, поэтому отказ дороги и его новая попытка второй строки не пишут, а
 * перезапуск ядра между просьбой и повтором метку не теряет.
 */
function journalReroute(
  task: LiveTask,
  where: { stepId: string; unitId: string | null },
  routing: StepRouting,
): void {
  const tier = routing.tier;
  if (!tier.ok) return;
  // `stepId` в конверте: по нему свёртка снимает метку паузы с шага.
  const unit = { ...(where.unitId ? { unitId: where.unitId } : {}), stepId: where.stepId };
  const why = 'observer park: the step restarts after its session was parked at a safe point';
  const prior = Object.values(task.state.sessions)
    .filter((x) => x.stepId === where.stepId)
    .at(-1);
  const moved =
    !prior ||
    prior.adapter !== tier.adapter ||
    prior.route.kind !== tier.route.kind ||
    prior.route.id !== tier.route.id;
  if (moved) {
    const body = tierDecisionBody(tier);
    task.append({
      kind: 'decision',
      actor: 'core',
      ...unit,
      data: { decisionId: newId(), ...body, reasons: [...body.reasons, why] },
    });
  }
  if (routing.continuation) {
    const body = continuationDecisionBody(routing.continuation);
    task.append({
      kind: 'decision',
      actor: 'core',
      ...unit,
      data: { decisionId: newId(), ...body, reasons: [...body.reasons, why] },
    });
  }
}

/** Вариант перевода был среди вариантов вопроса (`human.asked.options`). */
function offered(
  task: LiveTask,
  askId: string,
  o: { field: 'model' | 'adapter'; value: string },
): boolean {
  const label = `${o.field === 'adapter' ? 'cli' : 'model'}:${o.value}`;
  return readHumanLedger(task).asks[askId]?.options.includes(label) === true;
}

/** Маршрут прошлой сессии шага сменился (правка человека или «платный при отказе»). */
function routeMoved(task: LiveTask, stepId: string, tier: TierDecision & { ok: true }): boolean {
  const prior = Object.values(task.state.sessions)
    .filter((x) => x.stepId === stepId)
    .at(-1);
  return (
    prior !== undefined &&
    (prior.adapter !== tier.adapter ||
      prior.route.kind !== tier.route.kind ||
      prior.route.id !== tier.route.id)
  );
}

/**
 * Повтор шага после ожидания окна (этап 12, P169): у начатой задачи окно маршрут не двигает, сменить
 * его мог только клик человека (`set-model`/`set-cli`, ответ точки 7) или «платный при отказе».
 * Такой повтор пишет строку `tier` с причиной — экран видит, на чём шаг пошёл дальше и почему.
 */
function journalMoved(
  task: LiveTask,
  where: { stepId: string; unitId: string | null },
  routing: StepRouting,
): void {
  const tier = routing.tier;
  if (!tier.ok || !routeMoved(task, where.stepId, tier)) return;
  const body = tierDecisionBody(tier);
  task.append({
    kind: 'decision',
    actor: 'core',
    ...(where.unitId ? { unitId: where.unitId } : {}),
    stepId: where.stepId,
    data: {
      decisionId: newId(),
      ...body,
      reasons: [...body.reasons, 'the step resumes on a route other than its last session'],
    },
  });
}

/**
 * Отказ дороги (не бюджет брифа): строка `signal` в журнале задачи — человек и панель видят
 * причину, а новая строка будит цикл на следующую попытку; на `SESSION_REFUSALS_CAP`-й отказ шаг
 * кончается `no-outcome` и идёт по G14 к точке 6, а не ждёт молча (core.jsonl человек не читает).
 */
async function sessionRefused(ctx: PerformCtx, stepId: string, reason: string): Promise<void> {
  const count = (ctx.refusals.get(stepId) ?? 0) + 1;
  ctx.refusals.set(stepId, count);
  ctx.task.append({
    kind: 'signal',
    actor: 'core',
    stepId,
    data: {
      signal: SESSION_REFUSED_SIGNAL,
      severity: 'warn',
      subject: stepId,
      detail: `${count}/${SESSION_REFUSALS_CAP}: ${reason}`,
    },
  });
  if (count < SESSION_REFUSALS_CAP) return;
  ctx.refusals.delete(stepId);
  await failStep(ctx, stepId, `${END_REASON.noOutcome}: session refused ${count} times: ${reason}`);
}

/** Исход без заявления (02:47): правки + зелёные ворота → `done(derived)`, иначе без исхода. */
async function deriveOutcome(ctx: PerformCtx, stepId: string): Promise<void> {
  const s = stepCtx(ctx, stepId);
  if (!s) return;
  const post = await hook.postStep(ctx.deps.hooks, s, null);
  if (post.verdict.ok && post.facts['edits'] === true) {
    stepMove(ctx.task, stepId, 'check');
    await settle(ctx, stepId, post.verdict, 'derived');
    return;
  }
  const why = post.verdict.ok ? 'no edits, no step_done' : `${post.verdict.code}`;
  await failStep(ctx, stepId, `${END_REASON.noOutcome}: ${why}`, 'derived');
}

async function remind(ctx: PerformCtx, a: Extract<NextAction, { kind: 'remind' }>) {
  ctx.task.append({
    kind: 'step.reminded',
    actor: 'core',
    stepId: a.stepId,
    sessionId: a.sessionId,
    data: { stepId: a.stepId, sessionId: a.sessionId, turnSeq: a.turnSeq, count: a.count },
  });
  const live = ctx.live.get(a.stepId);
  if (!live) return;
  live.turnEnd = null;
  live.sentSeq = ctx.task.state.seq;
  await ctx.deps.sessions.send(live.sessionId, REMINDER_TEXT, `remind:${a.stepId}:${a.turnSeq}`);
}

function createUnit(ctx: PerformCtx): void {
  const unitId = newId();
  const repoKey = ctx.task.state.created?.repos[0]?.repoKey ?? 'r1';
  ctx.task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      name: 'unit',
      repoKey,
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: ['**'],
      after: [],
      contract: false,
      splitId: null,
    },
  });
}

/** Сессии снимаются до строки конца; крючки конца — у исполнителя (`closeEnded`), один раз. */
async function finishTask(ctx: PerformCtx, event: TaskEvent): Promise<void> {
  for (const stepId of [...ctx.live.keys()]) await endSession(ctx, stepId, 'tree');
  taskMove(ctx.task, event);
}

export async function perform(ctx: PerformCtx, a: NextAction): Promise<void> {
  const { task } = ctx;
  switch (a.kind) {
    case 'create-unit':
      return createUnit(ctx);
    case 'start-unit': {
      const got = await hook.unitStart(ctx.deps.hooks, unitCtx(ctx, a.unitId));
      unitMove(task, a.unitId, got.verdict.ok ? 'start' : 'close');
      return;
    }
    case 'start-step':
      startStep(ctx, a.unitId, a.stepDefId, a.round);
      return;
    case 'run-step':
      return runStep(ctx, a.stepId);
    case 'run-core-step':
      return runCoreStep(ctx, a.stepId);
    case 'post-step': {
      const s = stepCtx(ctx, a.stepId);
      if (!s) return;
      const claim = task.state.steps[a.stepId]?.claim?.call ?? null;
      const post = await hook.postStep(ctx.deps.hooks, s, claim);
      return settle(ctx, a.stepId, post.verdict, 'claimed');
    }
    case 'remind':
      return remind(ctx, a);
    case 'derive-outcome':
      return deriveOutcome(ctx, a.stepId);
    case 'stop-step':
      return failStep(ctx, a.stepId, a.reason);
    case 'park-session':
      return endSession(ctx, a.stepId, a.mode);
    case 'extend-budget': {
      const rec = task.state.steps[a.stepId];
      task.append({
        kind: 'budget.state',
        actor: 'core',
        stepId: a.stepId,
        data: {
          scope: `${STEP_BUDGET_SCOPE}${a.stepId}`,
          spent: rec?.budgetMs ?? 0,
          limit: a.limitMs,
        },
      });
      stepMove(task, a.stepId, 'answered');
      return;
    }
    case 'extend-tokens': {
      task.append({
        kind: 'budget.state',
        actor: 'core',
        stepId: a.stepId,
        data: {
          scope: tokenScope(a.stepId),
          spent: stepTokens(task.state, a.stepId),
          limit: a.limitTokens,
        },
      });
      stepMove(task, a.stepId, 'answered');
      return;
    }
    case 'answered':
      // Клик человека на точке 7 (P169): правка задачи с основанием — id вопроса, затем шаг идёт.
      // Только вариант, который вопрос предлагал: свой текст ответа маршрут не двигает.
      if (a.override && offered(task, a.askId, a.override))
        task.append({
          kind: 'override.set',
          actor: 'core',
          data: {
            cmdId: a.askId,
            scope: 'task',
            scopeId: task.taskId,
            field: a.override.field,
            value: a.override.value,
            timing: 'now',
          },
        });
      stepMove(task, a.stepId, 'answered');
      return;
    case 'close-human-step':
      stepMove(task, a.stepId, 'answered');
      stepMove(task, a.stepId, 'check');
      stepMove(task, a.stepId, 'checked-green');
      stepEnded(task, a.stepId, 'done', 'human', `${END_REASON.human}: answered ${a.askId}`);
      return;
    case 'close-chat':
      // Мягко: ход, идущий сейчас, доходит до границы — разговор не обрывается посреди ответа.
      // Переходы, недопустимые из текущего состояния, машина пропускает (`stepMove` → false).
      await endSession(ctx, a.stepId, 'soft');
      stepMove(task, a.stepId, 'start');
      stepMove(task, a.stepId, 'answered');
      stepMove(task, a.stepId, 'check');
      stepMove(task, a.stepId, 'checked-green');
      stepEnded(task, a.stepId, 'done', 'human', `${END_REASON.endChat}: ${a.cmdId}`);
      return;
    case 'close-ask':
      // Ход уже на границе (`turnEnd`): сессия снимается мягко, шаг — сделан ядром.
      await endSession(ctx, a.stepId, 'soft');
      stepMove(task, a.stepId, 'start');
      stepMove(task, a.stepId, 'answered');
      stepMove(task, a.stepId, 'check');
      stepMove(task, a.stepId, 'checked-green');
      stepEnded(task, a.stepId, 'done', 'core', END_REASON.askAnswered);
      return;
    case 'raise': {
      if (a.capStep) {
        await endSession(ctx, a.stepId, 'tree');
        stepMove(task, a.stepId, 'round-cap');
      }
      // Точка 7 исчерпанного маршрута может прийти к шагу, ещё не начатому: вопрос шага ведёт
      // машина из `running`.
      if (task.state.steps[a.stepId]?.state === 'queued') stepMove(task, a.stepId, 'start');
      const source = a.point === 6 ? 'round-cap' : a.point === 7 ? 'budget' : 'scenario-step';
      ctx.deps.raise({
        source,
        stepId: a.stepId,
        sessionId: null,
        action: null,
        point: a.point,
        dedupe: a.dedupe,
        question: a.question,
        options: a.options,
        recommendation: a.recommendation,
        blocking: true,
      });
      return;
    }
    case 'reenter-step': {
      const rec = task.state.steps[a.stepId];
      if (!rec) return;
      await failStep(ctx, a.stepId, `${END_REASON.superseded}: ${a.why}, round ${a.round}`);
      startStep(ctx, rec.unitId, rec.stepDefId, a.round);
      return;
    }
    case 'skip-step': {
      const stepId = startStep(ctx, a.unitId, a.stepDefId, a.round);
      stepMove(task, stepId, 'skip');
      stepEnded(task, stepId, 'skipped', a.basis, a.reason);
      return;
    }
    case 'end-unit': {
      // Крючки конца единицы — после перехода: копию снимают по конечному состоянию (закрыта или
      // сдана), до перехода крючок видел бы ещё «идёт» и копию оставлял.
      unitMove(task, a.unitId, a.event);
      const state = task.state.units[a.unitId]?.state;
      if (state === 'closed' || state === 'done') {
        await hook.unitEnd(ctx.deps.hooks, unitCtx(ctx, a.unitId));
      }
      return;
    }
    case 'launch-children':
      // Родитель XL (Q-2 s11): следующая волна детей; без порта суд этого действия не даёт.
      return ctx.deps.xl?.launch(task, a.names);
    case 'finish-task':
      return finishTask(ctx, 'finish');
    case 'fail-task':
      return finishTask(ctx, 'fail');
    case 'cancel-task':
      return finishTask(ctx, 'cancel');
    case 'wait':
      return;
  }
}
