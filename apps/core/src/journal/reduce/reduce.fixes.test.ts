import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import type { TaskFoldState } from './reduce.types.ts';

/**
 * Ревью core-s2 F-52: повторное create-событие той же сущности молча сбрасывало запись —
 * выполненное действие снова `started`, решённая команда снова `received`. F-103: id из
 * данных (`constructor`, `__proto__`) не находит унаследованное свойство как «запись».
 */
const TASK = newId();
const BOOT = newId();

function line(seq: number, kind: JournalKind, data: unknown, extra: Partial<JournalLine> = {}) {
  return {
    v: 1,
    seq,
    at: 1_000 + seq,
    mono: seq * 10,
    bootId: BOOT,
    taskId: TASK,
    kind,
    actor: 'core',
    data,
    ...extra,
  } as JournalLine;
}

const fold = (lines: JournalLine[]): TaskFoldState => lines.reduce(reduce, initialState(TASK));

const PROOF = { token: 'core', nonce: 'valid', peer: 'clear', signature: 'absent' };

describe('core-s2 reduce: duplicate create events and inherited ids', () => {
  it('F-52 a second create of the same entity is an anomaly; the record keeps its progress', () => {
    const actionId = newId();
    const cmdId = newId();
    const unitId = newId();
    const stepId = newId();
    const sessionId = newId();
    const askId = newId();
    const rid = newId();
    const action = { actionId, kind: 'git.push', target: 'r1', idempotencyHint: 'h' };
    const command = { kind: 'cancel', target: { taskId: TASK }, expectSeq: null, fields: {} };
    const session = { sessionId, stepId, adapter: 'claude', route: 'r', modelAsked: 'm' };
    const resource = { rid, kind: 'worktree', owner: 'core', release: 'task-end', ref: 'x' };
    const created = { title: 'a' };
    const lines = [
      line(1, 'task.created', created),
      line(2, 'action.started', action),
      line(3, 'action.done', { actionId, result: null }),
      line(4, 'command.received', { ...command, proof: PROOF }, { cmdId }),
      line(5, 'command.applied', { outcome: null }, { cmdId }),
      line(6, 'unit.created', { unitId, branch: 'b1' }),
      line(7, 'unit.transition', { unitId, event: 'start', from: 'planned', to: 'running' }),
      line(8, 'step.started', { stepId, unitId, stepKind: 'work' }),
      line(9, 'session.started', session),
      line(10, 'human.asked', { askId, point: 1, question: 'q', options: [], defaultAction: null }),
      line(11, 'resource.created', resource),
      line(12, 'resource.released', { rid }),
    ];
    const before = fold(lines);
    const unitBefore = before.units[unitId];
    expect(unitBefore?.state).toBe('running');
    expect(before.anomalies).toEqual([]);
    const dupes = [
      line(13, 'task.created', { title: 'b' }),
      line(14, 'action.started', action),
      line(15, 'command.received', { ...command, proof: PROOF }, { cmdId }),
      line(16, 'unit.created', { unitId, branch: 'b2' }),
      line(17, 'step.started', { stepId, unitId, stepKind: 'other' }),
      line(18, 'session.started', { ...session, adapter: 'other' }),
      line(19, 'human.asked', { askId, point: 2, question: 'q', options: [], defaultAction: null }),
      line(20, 'resource.created', resource),
    ];
    const after = dupes.reduce(reduce, before);
    expect(after.created).toEqual(created);
    expect(after.actions[actionId]?.status).toBe('done');
    expect(after.commands[cmdId]?.status).toBe('applied');
    expect(after.units[unitId]).toEqual(unitBefore);
    expect(after.steps[stepId]).toEqual(before.steps[stepId]);
    expect(after.sessions[sessionId]).toEqual(before.sessions[sessionId]);
    expect(after.asks[askId]).toEqual(before.asks[askId]);
    expect(after.resources[rid]?.status).toBe('released');
    expect(after.anomalies.map((a) => a.seq)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('F-103 an id equal to an inherited property name is not an existing record', () => {
    const state = fold([
      line(1, 'action.done', { actionId: 'constructor', result: null }),
      line(2, 'decision', {
        class: 'reconcile',
        output: { actionId: 'constructor', verdict: 'ask' },
      }),
      line(3, 'command.applied', { outcome: null }, { cmdId: 'toString' }),
      line(4, 'resource.released', { rid: 'hasOwnProperty' }),
      line(5, 'unit.transition', {
        unitId: 'constructor',
        event: 'start',
        from: 'planned',
        to: 'running',
      }),
    ]);
    expect(state.anomalies.map((a) => a.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(Object.hasOwn(state.actions, 'constructor')).toBe(false);
    expect(Object.hasOwn(state.commands, 'toString')).toBe(false);
    expect(Object.hasOwn(state.resources, 'hasOwnProperty')).toBe(false);
    expect(Object.hasOwn(state.units, 'constructor')).toBe(false);
  });
});
