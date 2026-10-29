import type { JournalLine } from '@agentdeck/contracts/core/journal';
import {
  ASK_MACHINE,
  CHECK_MACHINE,
  nextState,
  PUBLISH_MACHINE,
  SESSION_MACHINE,
  STEP_MACHINE,
  TASK_MACHINE,
  UNIT_MACHINE,
  type MachineDef,
  type TaskState,
} from '@agentdeck/contracts/core/states';
import { commandBodyHash } from '../command-body.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * `reduce(state, event)` — чистая свёртка журнала (01 §State). Зовут её только `resume()` и вид
 * для чтения (P11; правило depcruise `core-reduce-only-via-resume`). Переход машины применяется,
 * только если `from` совпал с текущим и таблица `core/states.ts` даёт `to`; иначе событие
 * остаётся в журнале и уходит в `anomalies` — свёртка не придумывает состояний.
 */

export function initialState(taskId: string): TaskFoldState {
  return {
    reducer: REDUCER_VERSION,
    taskId,
    seq: 0,
    lastAt: null,
    created: null,
    task: TASK_MACHINE.initial,
    ended: null,
    units: {},
    steps: {},
    sessions: {},
    checks: {},
    asks: {},
    publish: {},
    actions: {},
    commands: {},
    resources: {},
    lease: { leaseId: null, takeovers: 0 },
    counters: { masked: 0, repairedBytes: 0, errors: 0, clockJumps: 0 },
    work: { activeMs: 0, lastMono: null, lastBootId: null },
    anomalies: [],
  };
}

/** Состояния задачи, в которых идёт работа (паузы, ожидание человека и окна не считаются). */
const WORKING: readonly TaskState[] = ['estimating', 'running', 'publishing'];

function applyTransition<S extends string, E extends string>(
  machine: MachineDef<S, E>,
  current: S | undefined,
  data: { event: E; from: S; to: S },
): { ok: true; to: S } | { ok: false; reason: string } {
  if (current === undefined) return { ok: false, reason: `${machine.name}: unknown entity` };
  if (current !== data.from)
    return { ok: false, reason: `${machine.name}: from ${data.from} but state is ${current}` };
  const next = nextState(machine, current, data.event);
  if (!next.ok)
    return { ok: false, reason: `${machine.name}: ${data.event} rejected in ${current}` };
  if (next.to !== data.to)
    return {
      ok: false,
      reason: `${machine.name}: ${data.event} leads to ${next.to}, not ${data.to}`,
    };
  return next;
}

function accrueWork(state: TaskFoldState, line: JournalLine): TaskFoldState['work'] {
  const { work } = state;
  let activeMs = work.activeMs;
  if (work.lastBootId === line.bootId && work.lastMono !== null && WORKING.includes(state.task)) {
    let delta = line.mono - work.lastMono;
    if (line.kind === 'clock.jump') {
      const jump = line.data as JournalLine<'clock.jump'>['data'];
      delta -= jump.suspendedMs;
    }
    activeMs += Math.max(0, delta);
  }
  return { activeMs, lastMono: line.mono, lastBootId: line.bootId };
}

/**
 * Запись по id из данных — только своя: `constructor` или `toString` из журнала не находят
 * унаследованное свойство объекта как «существующую запись» (ревью core-s2 F-103).
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function reduce(state: TaskFoldState, line: JournalLine): TaskFoldState {
  const next: TaskFoldState = {
    ...state,
    seq: line.seq,
    lastAt: line.at,
    work: accrueWork(state, line),
    counters: { ...state.counters, masked: state.counters.masked + (line.masked ?? 0) },
  };
  const anomaly = (reason: string): TaskFoldState => ({
    ...next,
    anomalies: [...next.anomalies, { seq: line.seq, reason }].slice(-50),
  });
  // Второе рождение той же сущности не сбрасывает запись: иначе выполненное действие снова
  // `started`, решённая команда снова `received` (ревью core-s2 F-52).
  const twice = (what: string, id: string): TaskFoldState => anomaly(`${what} ${id} created twice`);

  switch (line.kind) {
    case 'task.created':
      if (next.created !== null) return anomaly('task.created twice');
      return { ...next, created: (line as JournalLine<'task.created'>).data };
    case 'task.transition': {
      const data = (line as JournalLine<'task.transition'>).data;
      const result = applyTransition(TASK_MACHINE, next.task, data);
      return result.ok ? { ...next, task: result.to } : anomaly(result.reason);
    }
    case 'task.ended':
      return { ...next, ended: (line as JournalLine<'task.ended'>).data.outcome };
    case 'unit.created': {
      const data = (line as JournalLine<'unit.created'>).data;
      if (own(next.units, data.unitId)) return twice('unit', data.unitId);
      return {
        ...next,
        units: {
          ...next.units,
          [data.unitId]: { state: UNIT_MACHINE.initial, branch: data.branch },
        },
      };
    }
    case 'unit.transition': {
      const data = (line as JournalLine<'unit.transition'>).data;
      const unit = own(next.units, data.unitId);
      const result = applyTransition(UNIT_MACHINE, unit?.state, data);
      if (!result.ok || !unit) return anomaly(result.ok ? 'unit missing' : result.reason);
      return { ...next, units: { ...next.units, [data.unitId]: { ...unit, state: result.to } } };
    }
    case 'step.started': {
      const data = (line as JournalLine<'step.started'>).data;
      if (own(next.steps, data.stepId)) return twice('step', data.stepId);
      const step = { state: STEP_MACHINE.initial, unitId: data.unitId, stepKind: data.stepKind };
      return { ...next, steps: { ...next.steps, [data.stepId]: step } };
    }
    case 'step.transition': {
      const data = (line as JournalLine<'step.transition'>).data;
      const step = own(next.steps, data.stepId);
      const result = applyTransition(STEP_MACHINE, step?.state, data);
      if (!result.ok || !step) return anomaly(result.ok ? 'step missing' : result.reason);
      return { ...next, steps: { ...next.steps, [data.stepId]: { ...step, state: result.to } } };
    }
    case 'step.claimed': {
      // Заявление `step_done` само переводит шаг в проверку: отдельной строки перехода нет.
      const data = (line as JournalLine<'step.claimed'>).data;
      const step = own(next.steps, data.stepId);
      if (!step) return anomaly('step.claimed: step missing');
      if (data.claim.stepId !== data.stepId)
        return anomaly('step.claimed: claim names another step');
      const moved = nextState(STEP_MACHINE, step.state, 'check');
      if (!moved.ok) return anomaly(`step.claimed: check rejected in ${step.state}`);
      const claimed = { ...step, state: moved.to, claim: { seq: line.seq, call: data.claim } };
      return { ...next, steps: { ...next.steps, [data.stepId]: claimed } };
    }
    case 'session.started': {
      const d = (line as JournalLine<'session.started'>).data;
      if (own(next.sessions, d.sessionId)) return twice('session', d.sessionId);
      const session = {
        state: SESSION_MACHINE.initial,
        stepId: d.stepId,
        adapter: d.adapter,
        route: d.route,
        modelAsked: d.modelAsked,
        modelServed: d.modelServed,
        hostPid: d.hostPid,
        hostStart: d.hostStart,
        cliPid: d.cliPid,
        cliStart: d.cliStart,
      };
      return { ...next, sessions: { ...next.sessions, [d.sessionId]: session } };
    }
    case 'session.transition': {
      const data = (line as JournalLine<'session.transition'>).data;
      const session = own(next.sessions, data.sessionId);
      const result = applyTransition(SESSION_MACHINE, session?.state, data);
      if (!result.ok || !session) return anomaly(result.ok ? 'session missing' : result.reason);
      return {
        ...next,
        sessions: { ...next.sessions, [data.sessionId]: { ...session, state: result.to } },
      };
    }
    case 'check.transition': {
      const data = (line as JournalLine<'check.transition'>).data;
      const current =
        own(next.checks, data.checkRunId)?.state ??
        (data.from === CHECK_MACHINE.initial ? data.from : undefined);
      const result = applyTransition(CHECK_MACHINE, current, data);
      if (!result.ok) return anomaly(result.reason);
      const known = own(next.checks, data.checkRunId);
      return {
        ...next,
        checks: { ...next.checks, [data.checkRunId]: { ...known, state: result.to } },
      };
    }
    case 'check.requested': {
      // Личность прогона (G24): проверка, единица, ключ — то, без чего прогон после краха не
      // возобновить и не снять. Начало — `queued`, как у машины.
      const data = (line as JournalLine<'check.requested'>).data;
      if (own(next.checks, data.checkRunId)) return twice('check', data.checkRunId);
      return {
        ...next,
        checks: { ...next.checks, [data.checkRunId]: { state: CHECK_MACHINE.initial, run: data } },
      };
    }
    case 'check.recorded': {
      const data = (line as JournalLine<'check.recorded'>).data;
      const check = own(next.checks, data.checkRunId);
      if (!check) return anomaly(`check.recorded: unknown check ${data.checkRunId}`);
      // Запись одна на прогон: вторая с другим номером — аномалия, первая остаётся.
      if (check.recordId !== undefined && check.recordId !== data.recordId)
        return anomaly(`check.recorded: ${data.checkRunId} already recorded ${check.recordId}`);
      return {
        ...next,
        checks: { ...next.checks, [data.checkRunId]: { ...check, recordId: data.recordId } },
      };
    }
    case 'human.asked': {
      const data = (line as JournalLine<'human.asked'>).data;
      if (own(next.asks, data.askId)) return twice('ask', data.askId);
      return {
        ...next,
        asks: { ...next.asks, [data.askId]: { state: ASK_MACHINE.initial, point: data.point } },
      };
    }
    case 'ask.transition': {
      const data = (line as JournalLine<'ask.transition'>).data;
      const ask = own(next.asks, data.askId);
      const result = applyTransition(ASK_MACHINE, ask?.state, data);
      if (!result.ok || !ask) return anomaly(result.ok ? 'ask missing' : result.reason);
      return { ...next, asks: { ...next.asks, [data.askId]: { ...ask, state: result.to } } };
    }
    case 'publish.transition': {
      const data = (line as JournalLine<'publish.transition'>).data;
      const current =
        own(next.publish, data.unitId)?.state ??
        (data.from === PUBLISH_MACHINE.initial ? data.from : undefined);
      const result = applyTransition(PUBLISH_MACHINE, current, data);
      if (!result.ok) return anomaly(result.reason);
      return { ...next, publish: { ...next.publish, [data.unitId]: { state: result.to } } };
    }
    case 'action.started': {
      const d = (line as JournalLine<'action.started'>).data;
      if (own(next.actions, d.actionId)) return twice('action', d.actionId);
      const action = {
        kind: d.kind,
        target: d.target,
        idempotencyHint: d.idempotencyHint,
        status: 'started' as const,
        startedSeq: line.seq,
        startedAt: line.at,
      };
      return { ...next, actions: { ...next.actions, [d.actionId]: action } };
    }
    case 'action.done':
    case 'action.failed': {
      const d = line.data as { actionId: string; code?: string };
      const action = own(next.actions, d.actionId);
      if (!action) return anomaly(`action ${d.actionId} finished without start`);
      const status = line.kind === 'action.done' ? ('done' as const) : ('failed' as const);
      const updated = { ...action, status, ...(d.code ? { code: d.code } : {}) };
      return { ...next, actions: { ...next.actions, [d.actionId]: updated } };
    }
    case 'decision': {
      // Сверка не смогла узнать исход и спросила человека: действие ждёт ответа, а не новой
      // сверки на каждой загрузке (иначе вопрос множится).
      const d = (line as JournalLine<'decision'>).data;
      const out = d.output as { actionId?: unknown; verdict?: unknown } | null;
      if (d.class !== 'reconcile' || !out || out.verdict !== 'ask') return next;
      const actionId = typeof out.actionId === 'string' ? out.actionId : '';
      const action = own(next.actions, actionId);
      if (!action) return anomaly(`reconcile ask for unknown action ${actionId}`);
      return {
        ...next,
        actions: { ...next.actions, [actionId]: { ...action, status: 'awaiting-human' } },
      };
    }
    case 'command.received': {
      const d = (line as JournalLine<'command.received'>).data;
      if (!line.cmdId) return anomaly('command without cmdId');
      if (own(next.commands, line.cmdId)) return twice('command', line.cmdId);
      const record = {
        kind: d.kind,
        status: 'received' as const,
        receivedSeq: line.seq,
        proof: d.proof,
        bodyHash: commandBodyHash(d),
        ...((line.masked ?? 0) > 0 ? { masked: true } : {}),
      };
      return { ...next, commands: { ...next.commands, [line.cmdId]: record } };
    }
    case 'command.applied':
    case 'command.rejected': {
      const command = line.cmdId ? own(next.commands, line.cmdId) : undefined;
      if (!command || !line.cmdId) return anomaly('command outcome without received');
      const d = line.data as { outcome?: unknown; code?: string; reason?: string };
      const status = line.kind === 'command.applied' ? ('applied' as const) : ('rejected' as const);
      const record = { ...command, status, outcomeSeq: line.seq, ...d };
      return { ...next, commands: { ...next.commands, [line.cmdId]: record } };
    }
    case 'resource.created': {
      const d = (line as JournalLine<'resource.created'>).data;
      if (own(next.resources, d.rid)) return twice('resource', d.rid);
      return {
        ...next,
        resources: { ...next.resources, [d.rid]: { kind: d.kind, status: 'live' } },
      };
    }
    case 'resource.released':
    case 'resource.verified':
    case 'resource.leak': {
      const d = line.data as { rid: string };
      const resource = own(next.resources, d.rid);
      if (!resource) return anomaly(`resource ${d.rid} unknown`);
      const status =
        line.kind === 'resource.released'
          ? 'released'
          : line.kind === 'resource.verified'
            ? 'verified'
            : 'leak';
      return { ...next, resources: { ...next.resources, [d.rid]: { ...resource, status } } };
    }
    case 'lease.acquired': {
      const d = (line as JournalLine<'lease.acquired'>).data;
      return {
        ...next,
        lease: { leaseId: d.leaseId, takeovers: next.lease.takeovers + (d.takeoverOf ? 1 : 0) },
      };
    }
    case 'lease.released':
      return { ...next, lease: { ...next.lease, leaseId: null } };
    case 'journal.repaired':
      return {
        ...next,
        counters: {
          ...next.counters,
          repairedBytes:
            next.counters.repairedBytes + (line as JournalLine<'journal.repaired'>).data.bytes,
        },
      };
    case 'error':
      return { ...next, counters: { ...next.counters, errors: next.counters.errors + 1 } };
    case 'clock.jump':
      return { ...next, counters: { ...next.counters, clockJumps: next.counters.clockJumps + 1 } };
    default:
      // Прочие виды (телеметрия, решения, сигналы, бюджет…) состояния задачи пока не меняют:
      // их читают по журналу части, которым они нужны.
      return next;
  }
}
