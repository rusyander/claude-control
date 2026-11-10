import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { taskViewSchema } from '@agentdeck/contracts/core/task-view';
import { taskViewOf } from '../../api/task-view.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { validateData } from '../line.ts';
import { CREATED } from '../__fixtures__/journal-harness.ts';
import { boardStopOf, openTakeoverOf } from './fold-view.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка v14 (этап 12, скелет S1): действие по умолчанию вопроса («ждёт вас»), остановка задачи
 * (запись доски и `task.stop`), перехват и возврат, потеря входа, конец MR — и вид задачи по ним.
 * Журнал до этапа 12 сворачивается как прежде: ни одного нового поля, ни одной аномалии.
 */

const TASK = newId();
const BOOT = newId();
const UNIT = newId();
const STEP = newId();
const ENTRY = newId();
const CMD = newId();

function line(seq: number, kind: JournalKind, data: unknown, extra: object = {}): JournalLine {
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

const created = (seq: number, more: object = {}) =>
  line(seq, 'task.created', { ...CREATED, ...more });

const asked = (seq: number, askId: string, defaultAction: string | null) =>
  line(seq, 'human.asked', {
    askId,
    point: 4,
    source: 'login',
    dedupe: null,
    question: 'q',
    options: ['relogin', 'stop'],
    defaultAction,
  });

const mr = (seq: number, title?: string) =>
  line(seq, 'publish.mr', {
    unitId: UNIT,
    forge: 'gitlab',
    mrId: 'm-1',
    mrIid: 7,
    url: 'https://forge.example.com/mr/7',
    sourceBranch: 'b',
    actionId: newId(),
    ...(title ? { title } : {}),
  });

const move = (seq: number, event: string, from: string, to: string) =>
  line(seq, 'task.transition', { taskId: TASK, event, from, to });

const view = (state: TaskFoldState, lines: JournalLine[]) =>
  taskViewOf({
    taskId: TASK,
    state,
    lines,
    priceFor: () => ({ unknown: 'no price in this test' }),
    attention: null,
  });

describe('fold v14: board stop, takeover, login lost, MR end', () => {
  it('pins the reducer version at 14', () => {
    expect(REDUCER_VERSION).toBe(14);
  });

  it('an old journal without boardEntry folds as before: no stage-12 field, no anomaly', () => {
    const lines = [created(1), mr(2)];
    // Строки старого журнала проходят строгую схему читателя (`read-lines` → `validateData`):
    // новые поля этапа 12 обязаны быть необязательными, иначе журнал до этапа 12 — «испорчен».
    expect(lines.map((l) => validateData(l.kind, l.data))).toEqual([[], []]);
    const s = fold(lines);
    expect(s.anomalies).toEqual([]);
    expect(boardStopOf(s)).toBeNull();
    expect(openTakeoverOf(s)).toBeNull();
    expect('stop' in s || 'takeover' in s || 'loginLost' in s || 'handback' in s).toBe(false);
    const v = view(s, lines);
    expect(taskViewSchema.safeParse(v).success).toBe(true);
    expect('stop' in v || 'takeover' in v || 'windowWait' in v).toBe(false);
    expect(v.mrs).toEqual([
      { unitId: UNIT, url: 'https://forge.example.com/mr/7', iid: 7, state: 'opened' },
    ]);
  });

  it('the ask keeps its defaultAction; the view carries it', () => {
    const blocking = newId();
    const soft = newId();
    const lines = [created(1), asked(2, blocking, null), asked(3, soft, 'stop')];
    const s = fold(lines);
    expect(s.asks[blocking]?.defaultAction).toBeNull();
    expect(s.asks[soft]?.defaultAction).toBe('stop');
    const byId = Object.fromEntries(view(s, lines).asks.map((a) => [a.askId, a.defaultAction]));
    expect(byId).toEqual({ [blocking]: null, [soft]: 'stop' });
  });

  it('the stop comes from the board entry, and the last task.stop overrides it', () => {
    const boardEntry = {
      entryId: ENTRY,
      stop: 'plan',
      source: 'manual',
      proof: { kind: 'human', cmdId: CMD },
    };
    const first = fold([created(1, { boardEntry })]);
    expect(boardStopOf(first)).toBe('plan');
    const lines = [
      created(1, { boardEntry }),
      line(2, 'task.stop', { stop: 'end' }),
      line(3, 'task.stop', { stop: 'mr' }),
    ];
    const s = fold(lines);
    expect(s.stop).toEqual({ stop: 'mr', seq: 3 });
    expect(boardStopOf(s)).toBe('mr');
    expect(view(s, lines).stop).toBe('mr');
  });

  it('takeover opens once, hand-back closes it with the note; contradictions are anomalies', () => {
    const lines = [
      created(1),
      line(2, 'task.takeover', { unitId: UNIT, copy: '/copies/u' }),
      line(3, 'task.takeover', { unitId: UNIT, copy: '/copies/u' }),
    ];
    const open = fold(lines);
    expect(openTakeoverOf(open)).toEqual({ unitId: UNIT, copy: '/copies/u', seq: 2 });
    expect(open.anomalies.map((a) => a.seq)).toEqual([3]);
    expect(view(open, lines).takeover).toEqual({ unitId: UNIT, copy: '/copies/u', seq: 2 });
    const back = [...lines, line(4, 'task.handback', { note: 'поправил' })];
    const closed = fold(back);
    expect(openTakeoverOf(closed)).toBeNull();
    expect(closed.handback).toEqual({ note: 'поправил', seq: 4 });
    expect(view(closed, back).takeover).toBeNull();
    const stray = fold([created(1), line(2, 'task.handback', {})]);
    expect(stray.anomalies).toEqual([{ seq: 2, reason: 'handback without an open takeover' }]);
    expect(stray.handback).toBeUndefined();
  });

  it('login lost is kept per step', () => {
    const s = fold([created(1), line(2, 'route.login-lost', { routeId: 'sub-1', stepId: STEP })]);
    expect(s.loginLost).toEqual({ [STEP]: { routeId: 'sub-1', seq: 2 } });
  });

  it('MR end needs its MR first; the title and the end reach the view', () => {
    const early = fold([
      created(1),
      line(2, 'publish.mr-state', { unitId: UNIT, state: 'merged', at: 9 }),
    ]);
    expect(early.anomalies.map((a) => a.seq)).toEqual([2]);
    expect(early.publication[UNIT]).toBeUndefined();
    const lines = [
      created(1),
      mr(2, 'Новая доска'),
      line(3, 'publish.mr-state', { unitId: UNIT, state: 'merged', at: 9 }),
    ];
    const s = fold(lines);
    expect(s.publication[UNIT]?.mrState).toEqual({ unitId: UNIT, state: 'merged', at: 9, seq: 3 });
    expect(view(s, lines).mrs).toEqual([
      {
        unitId: UNIT,
        url: 'https://forge.example.com/mr/7',
        iid: 7,
        title: 'Новая доска',
        state: 'merged',
      },
    ]);
  });

  it('waiting-window: the view names the holding window and the last tier alternatives', () => {
    const lines = [
      created(1),
      move(2, 'estimate', 'draft', 'estimating'),
      move(3, 'estimated', 'estimating', 'awaiting-launch'),
      move(4, 'launch', 'awaiting-launch', 'running'),
      line(5, 'window.state', {
        routeId: 'sub-1',
        limitKind: 'window',
        verdict: 'warn',
        resetAt: null,
      }),
      line(6, 'window.state', {
        routeId: 'sub-2',
        limitKind: 'window',
        verdict: 'exhausted',
        resetAt: 500,
      }),
      line(
        7,
        'decision',
        {
          decisionId: newId(),
          class: 'tier',
          inputs: [],
          facts: [],
          numbers: {},
          reasons: [],
          output: {
            refused: true,
            alternatives: ['a/cli:sub-1'],
            skipped: ['cli:sub-2=exhausted'],
          },
        },
        { stepId: STEP },
      ),
      move(8, 'window-wait', 'running', 'waiting-window'),
    ];
    const s = fold(lines);
    expect(s.anomalies).toEqual([]);
    expect(s.task).toBe('waiting-window');
    const v = view(s, lines);
    expect(taskViewSchema.safeParse(v).success).toBe(true);
    expect(v.windowWait).toEqual({
      stepId: STEP,
      routeId: 'sub-2',
      verdict: 'exhausted',
      resetAt: 500,
      alternatives: ['a/cli:sub-1'],
      skipped: ['cli:sub-2=exhausted'],
      seq: 6,
    });
    // Работает (`running`) — ожидания окна нет, даже при держащем окне в свёртке.
    const running = lines.slice(0, 7);
    expect('windowWait' in view(fold(running), running)).toBe(false);
  });
});
