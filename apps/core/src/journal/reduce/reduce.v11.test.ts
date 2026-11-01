import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка v11 (этап 8, закрытие): шаг, чья сессия кончилась при просьбе наблюдателя о паузе,
 * помнится в журнале до повтора (`observerParks`) — перезапуск ядра между просьбой и безопасной
 * точкой не теряет причину продолжения. Снимают метку строка маршрута шага или его новая сессия.
 */

const TASK = newId();
const BOOT = newId();
const STEP = newId();
const OTHER = newId();
const S1 = newId();
const S2 = newId();

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

const started = (seq: number, sessionId: string, stepId = STEP) =>
  line(seq, 'session.started', {
    sessionId,
    stepId,
    adapter: 'claude',
    route: { kind: 'cli-login', id: 'cli-login:claude' },
    modelAsked: null,
    modelServed: 'stub-model',
    hostPid: 1,
    hostStart: 'x',
    cliPid: null,
    cliStart: null,
  });

const move = (seq: number, sessionId: string, event: string, from: string, to: string) =>
  line(seq, 'session.transition', { sessionId, event, from, to });

const park = (seq: number, sessionId: string) =>
  line(
    seq,
    'signal',
    {
      signal: 'context-growth',
      severity: 'warn',
      action: 'pause-at-safe-point',
      subject: 's',
      detail: '',
    },
    { sessionId },
  );

const route = (seq: number, cls: string, stepId?: string) =>
  line(
    seq,
    'decision',
    {
      decisionId: newId(),
      class: cls,
      inputs: [],
      facts: [],
      numbers: {},
      reasons: [],
      output: { mode: 'fresh' },
    },
    stepId ? { stepId } : {},
  );

const parkedThenEnded = (end: 'exited' | 'host-dead') => [
  started(1, S1),
  move(2, S1, 'spawned', 'starting', 'live'),
  park(3, S1),
  move(4, S1, end, 'live', end === 'exited' ? 'ended' : 'lost'),
];

describe('reduce v11 (stage 8 close: observer park survives a restart)', () => {
  it('reducer version moved with the state shape', () => {
    expect(REDUCER_VERSION).toBe(11);
    expect(initialState(TASK).observerParks).toEqual({});
  });

  it('a session ending (soft park or host lost on restart) while its pause was asked marks its step with signal, cause seq and session', () => {
    for (const end of ['exited', 'host-dead'] as const) {
      const s = fold(parkedThenEnded(end));
      expect(s.observerParks).toEqual({
        [STEP]: { signal: 'context-growth', seq: 3, sessionId: S1 },
      });
      expect(s.sessions[S1]?.parkAsked).toBeNull();
    }
  });

  it('near-miss: a session ending with no pause asked, or a pause on a session still live, marks nothing', () => {
    const quiet = fold([started(1, S1), move(2, S1, 'spawned', 'starting', 'live')]);
    expect(reduce(quiet, move(3, S1, 'exited', 'live', 'ended')).observerParks).toEqual({});
    const live = fold(parkedThenEnded('exited').slice(0, 3));
    expect(live.observerParks).toEqual({});
    expect(reduce(live, move(4, S1, 'silent', 'live', 'quiet')).observerParks).toEqual({});
  });

  it('the step re-run clears the mark: its continuation or tier row, or its new session', () => {
    const marked = fold(parkedThenEnded('exited'));
    expect(reduce(marked, route(5, 'continuation', STEP)).observerParks).toEqual({});
    expect(reduce(marked, route(5, 'tier', STEP)).observerParks).toEqual({});
    expect(reduce(marked, started(5, S2)).observerParks).toEqual({});
  });

  it('near-miss: a route row of another step, a row with no step, another class or another step session keep the mark', () => {
    const marked = fold(parkedThenEnded('exited'));
    const kept = { [STEP]: { signal: 'context-growth', seq: 3, sessionId: S1 } };
    expect(reduce(marked, route(5, 'continuation', OTHER)).observerParks).toEqual(kept);
    expect(reduce(marked, route(5, 'continuation')).observerParks).toEqual(kept);
    expect(reduce(marked, route(5, 'reconcile', STEP)).observerParks).toEqual(kept);
    expect(reduce(marked, started(5, S2, OTHER)).observerParks).toEqual(kept);
    expect(reduce(marked, route(5, 'tier', STEP)).anomalies).toEqual([]);
  });
});
