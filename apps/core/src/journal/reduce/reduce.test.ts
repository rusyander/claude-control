import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
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
} from '@agentdeck/contracts/core/states';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import { commandBodyHash } from '../command-body.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка журнала (01 §State): чистая функция, машины применяются только по таблице
 * `core/states.ts`, противоречащее таблице событие видно в `anomalies` и состояние не меняет.
 */

const TASK = newId();
const BOOT = newId();

function at(seq: number): Pick<JournalLine, 'v' | 'seq' | 'at' | 'mono' | 'bootId' | 'taskId'> {
  return { v: 1, seq, at: 1_000 + seq, mono: seq * 10, bootId: BOOT, taskId: TASK };
}

function line(seq: number, kind: JournalKind, data: unknown, extra: Partial<JournalLine> = {}) {
  return { ...at(seq), kind, actor: 'core', data, ...extra } as JournalLine;
}

function fold(lines: JournalLine[], from: TaskFoldState = initialState(TASK)): TaskFoldState {
  return lines.reduce(reduce, from);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Где в состоянии живёт сущность машины и каким видом журнала она переходит. */
interface Seat {
  machine: MachineDef<string, string>;
  kind: JournalKind;
  idKey: string;
  place(state: TaskFoldState, id: string, at: string): TaskFoldState;
  read(state: TaskFoldState, id: string): string | undefined;
}

const SEATS: Seat[] = [
  {
    machine: TASK_MACHINE,
    kind: 'task.transition',
    idKey: 'taskId',
    place: (s, _id, st) => ({ ...s, task: st as TaskFoldState['task'] }),
    read: (s) => s.task,
  },
  {
    machine: UNIT_MACHINE,
    kind: 'unit.transition',
    idKey: 'unitId',
    place: (s, id, st) => ({ ...s, units: { [id]: { state: st as never, branch: 'b' } } }),
    read: (s, id) => s.units[id]?.state,
  },
  {
    machine: STEP_MACHINE,
    kind: 'step.transition',
    idKey: 'stepId',
    place: (s, id, st) => ({
      ...s,
      steps: { [id]: { state: st as never, unitId: newId(), stepKind: 'k' } },
    }),
    read: (s, id) => s.steps[id]?.state,
  },
  {
    machine: SESSION_MACHINE,
    kind: 'session.transition',
    idKey: 'sessionId',
    place: (s, id, st) => ({
      ...s,
      sessions: {
        [id]: {
          state: st as never,
          stepId: newId(),
          adapter: 'a',
          route: { kind: 'stub', id: 's' },
          modelAsked: 'm',
          modelServed: null,
          hostPid: 1,
          hostStart: 's',
          cliPid: null,
          cliStart: null,
        },
      },
    }),
    read: (s, id) => s.sessions[id]?.state,
  },
  {
    machine: CHECK_MACHINE,
    kind: 'check.transition',
    idKey: 'checkRunId',
    place: (s, id, st) => ({ ...s, checks: { [id]: { state: st as never } } }),
    read: (s, id) => s.checks[id]?.state,
  },
  {
    machine: ASK_MACHINE,
    kind: 'ask.transition',
    idKey: 'askId',
    place: (s, id, st) => ({ ...s, asks: { [id]: { state: st as never, point: 1 } } }),
    read: (s, id) => s.asks[id]?.state,
  },
  {
    machine: PUBLISH_MACHINE,
    kind: 'publish.transition',
    idKey: 'unitId',
    place: (s, id, st) => ({ ...s, publish: { [id]: { state: st as never } } }),
    read: (s, id) => s.publish[id]?.state,
  },
];

describe('reduce', () => {
  it('is pure and deterministic: frozen input untouched, the same lines give the same state', () => {
    const lines = [
      line(1, 'task.transition', { taskId: TASK, event: 'launch', from: 'draft', to: 'running' }),
      line(2, 'error', { code: 'e', detail: '' }),
      line(3, 'clock.jump', { suspendedMs: 0, wallDeltaMs: 0, monoDeltaMs: 0 }, { masked: 2 }),
    ];
    const start = deepFreeze(initialState(TASK));
    const a = fold(lines.map(deepFreeze), start);
    const b = fold(lines, initialState(TASK));
    expect(a).toEqual(b);
    expect(start.seq).toBe(0);
    expect(a).toMatchObject({
      reducer: REDUCER_VERSION,
      seq: 3,
      lastAt: 1_003,
      task: 'running',
      counters: { errors: 1, clockJumps: 1, masked: 2 },
      anomalies: [],
    });
  });

  it('every machine × every (state, event): applied exactly when the states table has a rule with that target, otherwise an anomaly and no change', () => {
    let checked = 0;
    const misses: string[] = [];
    for (const seat of SEATS) {
      const id = newId();
      for (const state of seat.machine.states) {
        const base = seat.place(initialState(TASK), id, state);
        for (const event of seat.machine.events) {
          const rule = nextState(seat.machine, state, event);
          const wrongTo = seat.machine.states.find((s) => !rule.ok || s !== rule.to) as string;
          const send = (to: string, from = state) =>
            reduce(base, line(1, seat.kind, { [seat.idKey]: id, event, from, to }));
          checked += 1;
          if (rule.ok) {
            const ok = send(rule.to);
            if (seat.read(ok, id) !== rule.to || ok.anomalies.length > 0)
              misses.push(`${seat.machine.name} ${state} --${event}--> ${rule.to} not applied`);
            const wrong = send(wrongTo);
            if (seat.read(wrong, id) !== state || wrong.anomalies.length !== 1)
              misses.push(`${seat.machine.name} ${state} --${event}--> ${wrongTo} accepted`);
          } else {
            const refused = send(wrongTo);
            if (seat.read(refused, id) !== state || refused.anomalies.length !== 1)
              misses.push(`${seat.machine.name} ${state} --${event}-- has no rule but applied`);
          }
          // Событие, записанное «из» другого состояния, свёртка не применяет.
          const other = seat.machine.states.find((s) => s !== state) as string;
          const stale = send(rule.ok ? rule.to : wrongTo, other);
          if (seat.read(stale, id) !== state || stale.anomalies.length !== 1)
            misses.push(`${seat.machine.name} stale from ${other} applied in ${state}`);
        }
      }
    }
    expect(misses).toEqual([]);
    expect(checked).toBe(
      SEATS.reduce((n, s) => n + s.machine.states.length * s.machine.events.length, 0),
    );
  });

  it('entities are born by their own events; a transition of an unknown entity is an anomaly', () => {
    const unitId = newId();
    const stepId = newId();
    const askId = newId();
    const s = fold([
      line(1, 'unit.created', { unitId, repoKey: 'r', branch: 'feat', ownedPaths: [] }),
      line(2, 'step.started', { stepId, unitId, stepKind: 'implement', budgetMs: 1 }),
      line(3, 'human.asked', { askId, point: 4, question: 'q', options: [], defaultAction: null }),
      line(4, 'unit.transition', { unitId, event: 'start', from: 'planned', to: 'running' }),
      line(5, 'step.transition', {
        stepId: newId(),
        event: 'start',
        from: 'queued',
        to: 'running',
      }),
      line(6, 'ask.transition', { askId, event: 'answer', from: 'open', to: 'answered' }),
    ]);
    expect(s.units[unitId]).toEqual({ state: 'running', branch: 'feat' });
    expect(s.steps[stepId]).toEqual({ state: 'queued', unitId, stepKind: 'implement' });
    expect(s.asks[askId]).toEqual({ state: 'answered', point: 4 });
    expect(s.anomalies).toEqual([{ seq: 5, reason: 'step: unknown entity' }]);
  });

  it('C step.claimed moves a running step to checking and keeps the claim; not running, missing or foreign step is an anomaly', () => {
    const unitId = newId();
    const stepId = newId();
    const sessionId = newId();
    const call = (id: string) => ({
      stepId: id,
      outcome: 'done',
      requirements: [],
      summary: 'готово',
    });
    const base = [
      line(1, 'unit.created', { unitId, repoKey: 'r', branch: 'feat', ownedPaths: [] }),
      line(2, 'step.started', { stepId, unitId, stepKind: 'work', budgetMs: 1 }),
    ];
    const claimed = (seq: number, id = stepId, claimOf = id) =>
      line(seq, 'step.claimed', { stepId: id, sessionId, claim: call(claimOf) });
    // Шаг ещё в очереди — проверка не начинается.
    expect(fold([...base, claimed(3)]).anomalies).toEqual([
      { seq: 3, reason: 'step.claimed: check rejected in queued' },
    ]);
    const running = [
      ...base,
      line(3, 'step.transition', { stepId, event: 'start', from: 'queued', to: 'running' }),
    ];
    const s = fold([...running, claimed(4)]);
    expect(s.steps[stepId]).toEqual({
      state: 'checking',
      unitId,
      stepKind: 'work',
      claim: { seq: 4, call: call(stepId) },
    });
    expect(s.anomalies).toEqual([]);
    // Второе заявление поверх проверки, чужой шаг, заявление о другом шаге — видны, не применены.
    const bad = fold([
      ...running,
      claimed(4),
      claimed(5),
      claimed(6, newId()),
      claimed(7, stepId, newId()),
    ]);
    expect(bad.steps[stepId]?.claim?.seq).toBe(4);
    expect(bad.anomalies.map((a) => a.reason)).toEqual([
      'step.claimed: check rejected in checking',
      'step.claimed: step missing',
      'step.claimed: claim names another step',
    ]);
  });

  it('commands: received keeps the proof; applied / rejected close it; an outcome without received is an anomaly', () => {
    const cmdId = newId();
    const proof = { token: 'core', nonce: 'valid', peer: 'clear', signature: 'absent' };
    const s = fold([
      line(
        1,
        'command.received',
        { kind: 'launch', target: {}, expectSeq: null, fields: {}, proof },
        { cmdId },
      ),
      line(2, 'command.applied', { outcome: { to: 'running' } }, { cmdId }),
      line(3, 'command.rejected', { code: 'x', reason: 'y' }, { cmdId: newId() }),
      line(4, 'command.received', {
        kind: 'launch',
        target: {},
        expectSeq: null,
        fields: {},
        proof,
      }),
    ]);
    expect(s.commands[cmdId]).toEqual({
      kind: 'launch',
      status: 'applied',
      receivedSeq: 1,
      proof,
      bodyHash: commandBodyHash({ kind: 'launch', target: {}, expectSeq: null, fields: {} }),
      outcomeSeq: 2,
      outcome: { to: 'running' },
    });
    expect(s.anomalies.map((a) => a.reason)).toEqual([
      'command outcome without received',
      'command without cmdId',
    ]);
  });

  it('actions, resources, lease and repair counters follow their events; a reconcile ask parks the action', () => {
    const a1 = newId();
    const a2 = newId();
    const rid = newId();
    const s = fold([
      line(1, 'action.started', { actionId: a1, kind: 'push', target: 'o/b', idempotencyHint: '' }),
      line(2, 'action.started', {
        actionId: a2,
        kind: 'copy-create',
        target: '/c',
        idempotencyHint: '',
      }),
      line(3, 'action.failed', { actionId: a2, code: 'busy', detail: '' }),
      line(4, 'decision', {
        class: 'reconcile',
        input: {},
        output: { actionId: a1, verdict: 'ask' },
      }),
      line(5, 'action.done', { actionId: newId() }),
      line(6, 'resource.created', { rid, kind: 'copy', ref: '/c', owner: 'core' }),
      line(7, 'resource.released', { rid }),
      line(8, 'lease.acquired', {
        leaseId: 'l1',
        build: 'b',
        pid: 1,
        pidStart: 's',
        takeoverOf: null,
      }),
      line(9, 'lease.acquired', {
        leaseId: 'l2',
        build: 'b',
        pid: 1,
        pidStart: 's',
        takeoverOf: 'l1',
      }),
      line(10, 'journal.repaired', { bytes: 17 }),
      line(11, 'task.ended', { outcome: 'cancelled' }),
    ]);
    expect(s.actions[a1]).toMatchObject({
      status: 'awaiting-human',
      startedSeq: 1,
      startedAt: 1_001,
    });
    expect(s.actions[a2]).toMatchObject({ status: 'failed', code: 'busy' });
    expect(s.resources[rid]).toEqual({ kind: 'copy', status: 'released' });
    expect(s.lease).toEqual({ leaseId: 'l2', takeovers: 1 });
    expect(s.counters.repairedBytes).toBe(17);
    expect(s.ended).toBe('cancelled');
    expect(s.anomalies).toHaveLength(1);
    expect(s.anomalies[0]?.reason).toMatch(/finished without start/);
  });

  it('anomalies are bounded: the last 50 are kept', () => {
    const lines = Array.from({ length: 70 }, (_, i) =>
      line(i + 1, 'unit.transition', {
        unitId: newId(),
        event: 'start',
        from: 'planned',
        to: 'running',
      }),
    );
    const s = fold(lines);
    expect(s.anomalies).toHaveLength(50);
    expect(s.anomalies[0]?.seq).toBe(21);
    expect(s.seq).toBe(70);
  });
});
