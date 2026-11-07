import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AskRecord, SessionRecord, StepRecord, TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка видов журнала этапа 4 (CD§10, свёртка v6): требования, деления, сценарий, правки,
 * доставки, допуски, отчёт, напоминания и продление срока шага, сигналы остановки шага. Чистая,
 * как `reduce`: противоречие — аномалия, запись не трогается. `undefined` — вид не этого модуля.
 */

type Anomaly = (reason: string) => TaskFoldState;

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

const TERMINAL_OF = { done: 'done', failed: 'failed', skipped: 'skipped' } as const;

/** Префикс области срока шага в `budget.state` (продление `once-more` / ответ на точку 7). */
export const STEP_BUDGET_SCOPE = 'step:';

/**
 * Сигнал «маршрут назвал модель» (P119): subject — модель первого хода сеанса. `session.started`
 * пишется до первого хода и несёт `modelServed: null` («ещё не назвал»), журнал только дописывается —
 * поэтому имя приходит этой строкой, а свёртка кладёт его в `sessions[id].modelServed` (первое
 * побеждает: подмена посреди сеанса — отдельный сигнал `route-mismatch`, не перезапись).
 */
export const MODEL_SERVED_SIGNAL = 'model-served';

/**
 * Утверждение человеком (02 §Split, точка 10) — второе решение по делению: оно идёт после
 * `accepted` / `edited` проверки. Остальные повторные решения — аномалия.
 */
function humanApproval(
  state: TaskFoldState['splits'][string]['state'],
  d: JournalLine<'split.decided'>['data'],
): boolean {
  return (
    (state === 'accepted' || state === 'edited') && d.outcome === 'approved' && d.by === 'human'
  );
}

function withStep(next: TaskFoldState, stepId: string, step: StepRecord): TaskFoldState {
  return { ...next, steps: { ...next.steps, [stepId]: step } };
}

function withAsk(next: TaskFoldState, askId: string, ask: AskRecord): TaskFoldState {
  return { ...next, asks: { ...next.asks, [askId]: ask } };
}

function withSession(next: TaskFoldState, sessionId: string, session: SessionRecord) {
  return { ...next, sessions: { ...next.sessions, [sessionId]: session } };
}

/**
 * Сигнал наблюдателя к сессии (этап 8): подсказка копится до конца хода, просьба о паузе ждёт
 * безопасной точки. Без сессии — аномалия: сигнал не о чем-то, что можно подсказать или парковать.
 */
function observerAsk(
  next: TaskFoldState,
  line: JournalLine<'signal'>,
  anomaly: Anomaly,
): TaskFoldState {
  const d = line.data;
  const session = line.sessionId ? own(next.sessions, line.sessionId) : undefined;
  if (!line.sessionId || !session)
    return anomaly(`signal ${d.signal}: ${d.action} without session`);
  if (d.action === 'pause-at-safe-point')
    return withSession(next, line.sessionId, {
      ...session,
      parkAsked: { signal: d.signal, seq: line.seq },
    });
  const key = line.cause === undefined ? undefined : String(line.cause);
  const decisionId = key === undefined ? undefined : own(next.hintDecisions, key);
  if (key === undefined || decisionId === undefined)
    return anomaly(`signal ${d.signal}: hint without its observer decision`);
  const { [key]: _taken, ...hintDecisions } = next.hintDecisions;
  const hint = {
    decisionId,
    seq: Number(key),
    signal: d.signal,
    subject: d.subject,
    detail: d.detail,
  };
  return withSession({ ...next, hintDecisions }, line.sessionId, {
    ...session,
    hints: [...session.hints, hint],
  });
}

/**
 * Подсказки дошли пачкой (F8): доставка называет последнее решение — снимаются оно и все прежние
 * подсказки сессии. Неизвестное решение (уже снято прежней доставкой) ничего не снимает.
 */
function hintsDelivered(next: TaskFoldState, sessionId: string, decisionId: string): TaskFoldState {
  const session = own(next.sessions, sessionId);
  const named = session?.hints.find((h) => h.decisionId === decisionId);
  if (!session || !named) return next;
  const hints = session.hints.filter((h) => h.seq > named.seq);
  return withSession(next, sessionId, { ...session, hints });
}

export function reduceStage4(
  next: TaskFoldState,
  line: JournalLine,
  anomaly: Anomaly,
): TaskFoldState | undefined {
  switch (line.kind) {
    case 'requirement.extracted': {
      const d = (line as JournalLine<'requirement.extracted'>).data;
      if (own(next.requirements, d.requirementId))
        return anomaly(`requirement ${d.requirementId} created twice`);
      const req = { ordinal: d.ordinal, text: d.text, source: d.source, verdict: 'open' as const };
      return {
        ...next,
        requirements: { ...next.requirements, [d.requirementId]: { ...req, evidence: [] } },
      };
    }
    case 'requirement.verdict': {
      const d = (line as JournalLine<'requirement.verdict'>).data;
      const req = own(next.requirements, d.requirementId);
      if (!req) return anomaly(`requirement.verdict: unknown ${d.requirementId}`);
      const judged = { ...req, verdict: d.verdict, evidence: d.evidence };
      return { ...next, requirements: { ...next.requirements, [d.requirementId]: judged } };
    }
    case 'requirement.reviewed': {
      const d = (line as JournalLine<'requirement.reviewed'>).data;
      return { ...next, extractionReview: { complete: d.complete, seq: line.seq } };
    }
    case 'split.proposed': {
      const d = (line as JournalLine<'split.proposed'>).data;
      if (own(next.splits, d.splitId)) return anomaly(`split ${d.splitId} created twice`);
      return {
        ...next,
        splits: { ...next.splits, [d.splitId]: { state: 'proposed', by: d.by, units: [] } },
      };
    }
    case 'split.decided': {
      const d = (line as JournalLine<'split.decided'>).data;
      const split = own(next.splits, d.splitId);
      if (!split) return anomaly(`split.decided: unknown ${d.splitId}`);
      if (split.state !== 'proposed' && !humanApproval(split.state, d))
        return anomaly(`split ${d.splitId} decided twice`);
      return { ...next, splits: { ...next.splits, [d.splitId]: { ...split, state: d.outcome } } };
    }
    case 'scenario.edited': {
      const d = (line as JournalLine<'scenario.edited'>).data;
      if (!next.scenario) return anomaly('scenario.edited before task.created');
      const pending = { to: d.to, applyNow: d.applyNow };
      return { ...next, scenario: { ...next.scenario, pending } };
    }
    case 'scenario.overlay': {
      const d = (line as JournalLine<'scenario.overlay'>).data;
      if (!next.scenario) return anomaly('scenario.overlay before task.created');
      const rejected = next.scenario.rejected + d.rejected.length;
      return { ...next, scenario: { ...next.scenario, rejected } };
    }
    case 'override.set': {
      const { cmdId: _cmd, ...d } = (line as JournalLine<'override.set'>).data;
      return { ...next, overrides: [...next.overrides, { seq: line.seq, ...d }] };
    }
    case 'message.delivered': {
      const d = (line as JournalLine<'message.delivered'>).data;
      // Доставка ровно одна (F26): вторая строка по той же ссылке — повтор, его видно.
      if (own(next.deliveries, d.ref.id)) return anomaly(`delivery ${d.ref.id} twice`);
      const delivery = { stepId: d.stepId, seq: line.seq };
      const delivered = { ...next, deliveries: { ...next.deliveries, [d.ref.id]: delivery } };
      return d.ref.kind === 'hint' ? hintsDelivered(delivered, d.sessionId, d.ref.id) : delivered;
    }
    case 'grant.given': {
      const { cmdId: _cmd, ...d } = (line as JournalLine<'grant.given'>).data;
      return { ...next, grants: [...next.grants, d] };
    }
    case 'report.final': {
      const d = (line as JournalLine<'report.final'>).data;
      return { ...next, report: { seq: line.seq, at: d.at } };
    }
    case 'step.reminded': {
      const d = (line as JournalLine<'step.reminded'>).data;
      const step = own(next.steps, d.stepId);
      if (!step) return anomaly('step.reminded: step missing');
      // P16: на один конец хода — одно напоминание, счёт подряд без пропусков.
      if (step.remindedTurns.includes(d.turnSeq))
        return anomaly(`step.reminded: turn ${d.turnSeq} reminded twice`);
      if (d.count !== step.reminders + 1)
        return anomaly(`step.reminded: count ${d.count} after ${step.reminders}`);
      return withStep(next, d.stepId, {
        ...step,
        reminders: d.count,
        remindedTurns: [...step.remindedTurns, d.turnSeq],
      });
    }
    case 'step.ended': {
      const d = (line as JournalLine<'step.ended'>).data;
      const step = own(next.steps, d.stepId);
      if (!step) return anomaly('step.ended: step missing');
      if (step.outcome !== undefined) return anomaly(`step.ended: ${d.stepId} ended twice`);
      // Исход — итог машины, а не её замена: шаг обязан уже стоять в том же конце.
      if (step.state !== TERMINAL_OF[d.outcome])
        return anomaly(`step.ended: ${d.outcome} but step is ${step.state}`);
      return withStep(next, d.stepId, {
        ...step,
        outcome: d.outcome,
        basis: d.basis,
        reason: d.reason,
      });
    }
    case 'budget.state': {
      const d = (line as JournalLine<'budget.state'>).data;
      if (!d.scope.startsWith(STEP_BUDGET_SCOPE)) return next;
      const stepId = d.scope.slice(STEP_BUDGET_SCOPE.length);
      const step = own(next.steps, stepId);
      if (!step) return anomaly(`budget.state: step ${stepId} missing`);
      return withStep(next, stepId, {
        ...step,
        budgetMs: d.limit ?? 0,
        extensions: step.extensions + 1,
      });
    }
    case 'signal': {
      // Сигнал `stop` по шагу (защищённые корни, F-061): шаг останавливается — это факт свёртки,
      // чтобы новое ядро после краха остановило тот же шаг, а не продолжило его.
      const d = (line as JournalLine<'signal'>).data;
      if (d.signal === MODEL_SERVED_SIGNAL && line.sessionId) {
        const session = own(next.sessions, line.sessionId);
        if (!session || session.modelServed !== null) return next;
        return {
          ...next,
          sessions: {
            ...next.sessions,
            [line.sessionId]: { ...session, modelServed: d.subject },
          },
        };
      }
      if (d.action === 'hint' || d.action === 'pause-at-safe-point')
        return observerAsk(next, line as JournalLine<'signal'>, anomaly);
      // Строка до этапа 8 (без действия) снимает шаг по серьёзности `stop`; с действием — только
      // `stop-step`: просьба о паузе с серьёзностью `stop` шаг не роняет.
      const stops = d.action === undefined ? d.severity === 'stop' : d.action === 'stop-step';
      if (!stops || !line.stepId) return next;
      const step = own(next.steps, line.stepId);
      if (!step) return next;
      return withStep(next, line.stepId, {
        ...step,
        stops: [...step.stops, `${d.signal}: ${d.subject}`],
      });
    }
    case 'human.answered': {
      const d = (line as JournalLine<'human.answered'>).data;
      const ask = own(next.asks, d.askId);
      if (!ask) return anomaly(`human.answered: unknown ask ${d.askId}`);
      if (ask.answer !== undefined) return anomaly(`human.answered: ${d.askId} answered twice`);
      // Поздний ответ (P71) хранится и показан; на вопрос он не отвечает.
      const late = ask.state === 'expired' || ask.state === 'withdrawn';
      return withAsk(next, d.askId, { ...ask, answer: d.answer, lateAnswer: late });
    }
    default:
      return undefined;
  }
}
