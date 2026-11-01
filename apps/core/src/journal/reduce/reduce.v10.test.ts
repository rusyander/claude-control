import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка v10 (этап 8, наблюдатель): сигнал с действием ложится в сессию — подсказка копится до
 * доставки, просьба о паузе ждёт безопасной точки до конца сессии; шаг снимает только
 * `stop-step`, а строка без действия (до этапа 8) — по серьёзности `stop`.
 */

const TASK = newId();
const BOOT = newId();
const UNIT = newId();
const STEP = newId();
const S1 = newId();
const S2 = newId();
const SCEN = { id: 'feature', version: 1 };

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

function fold(lines: JournalLine[]): TaskFoldState {
  return lines.reduce(reduce, initialState(TASK));
}

const started = (seq: number, sessionId: string) =>
  line(seq, 'session.started', {
    sessionId,
    stepId: STEP,
    adapter: 'claude',
    route: { kind: 'cli-login', id: 'cli-login:claude' },
    modelAsked: null,
    modelServed: 'stub-model',
    hostPid: 1,
    hostStart: 'x',
    cliPid: null,
    cliStart: null,
  });

const decision = (seq: number, decisionId: string, action: string, fired = true) =>
  line(seq, 'decision', {
    decisionId,
    class: 'observer',
    inputs: [],
    facts: [],
    numbers: {},
    reasons: [],
    output: { fired, signal: 'waste-reread', action, severity: 'info' },
  });

const signal = (
  seq: number,
  data: { signal?: string; severity?: string; action?: string; subject?: string; detail?: string },
  extra: Partial<JournalLine>,
) =>
  line(
    seq,
    'signal',
    { signal: 'waste-reread', severity: 'info', subject: 'f', detail: '', ...data },
    extra,
  );

const delivered = (seq: number, sessionId: string, id: string) =>
  line(seq, 'message.delivered', { stepId: STEP, sessionId, ref: { kind: 'hint', id } });

const sessionMove = (seq: number, sessionId: string, event: string, from: string, to: string) =>
  line(seq, 'session.transition', { sessionId, event, from, to });

describe('reduce v10 (stage 8 observer fold)', () => {
  it('reducer version moved with the state shape (old snapshots fold from the journal)', () => {
    expect(REDUCER_VERSION).toBeGreaterThanOrEqual(10);
    expect(initialState(TASK).hintDecisions).toEqual({});
  });

  it('hints: a hint signal lands on its session with the decisionId of its cause; delivery clears that hint and every earlier one', () => {
    const D1 = newId();
    const D2 = newId();
    const D3 = newId();
    const s = fold([
      started(1, S1),
      started(2, S2),
      decision(3, D1, 'hint'),
      signal(4, { action: 'hint', detail: 'read a.ts twice' }, { sessionId: S1, cause: 3 }),
      decision(5, D2, 'hint'),
      signal(6, { action: 'hint', detail: 'read b.ts twice' }, { sessionId: S1, cause: 5 }),
      decision(7, D3, 'hint'),
      signal(8, { action: 'hint', detail: 'other session' }, { sessionId: S2, cause: 7 }),
    ]);
    expect(s.sessions[S1]?.hints).toEqual([
      { decisionId: D1, seq: 3, signal: 'waste-reread', subject: 'f', detail: 'read a.ts twice' },
      { decisionId: D2, seq: 5, signal: 'waste-reread', subject: 'f', detail: 'read b.ts twice' },
    ]);
    expect(s.hintDecisions).toEqual({});
    expect(s.anomalies).toEqual([]);

    // Доставка называет первое решение — второе ждёт; называет последнее — снимает все прежние.
    const first = reduce(s, delivered(9, S1, D1));
    expect(first.sessions[S1]?.hints.map((h) => h.decisionId)).toEqual([D2]);
    const all = reduce(s, delivered(9, S1, D2));
    expect(all.sessions[S1]?.hints).toEqual([]);
    // Чужая сессия не тронута, доставка записана ровно один раз (F26).
    expect(all.sessions[S2]?.hints.map((h) => h.decisionId)).toEqual([D3]);
    expect(all.deliveries[D2]).toEqual({ stepId: STEP, seq: 9 });
    // Неизвестное решение (уже снятое) ничего не снимает.
    expect(reduce(all, delivered(10, S2, D1)).sessions[S2]?.hints).toHaveLength(1);
  });

  it('hints: a hint signal without its observer decision is an anomaly, a not-fired or non-hint decision waits for nothing', () => {
    const s = fold([
      started(1, S1),
      decision(2, newId(), 'hint', false),
      decision(3, newId(), 'stop-step'),
      signal(4, { action: 'hint' }, { sessionId: S1, cause: 2 }),
      signal(5, { action: 'hint' }, { sessionId: S1 }),
    ]);
    expect(s.hintDecisions).toEqual({});
    expect(s.sessions[S1]?.hints).toEqual([]);
    expect(s.anomalies.map((a) => a.reason)).toEqual([
      'signal waste-reread: hint without its observer decision',
      'signal waste-reread: hint without its observer decision',
    ]);
  });

  it('parkAsked: pause-at-safe-point marks the session, survives quiet/live moves, the session end clears it', () => {
    const s = fold([
      started(1, S1),
      sessionMove(2, S1, 'spawned', 'starting', 'live'),
      signal(3, { signal: 'context-growth', action: 'pause-at-safe-point' }, { sessionId: S1 }),
      sessionMove(4, S1, 'silent', 'live', 'quiet'),
    ]);
    expect(s.sessions[S1]?.parkAsked).toEqual({ signal: 'context-growth', seq: 3 });
    expect(reduce(s, sessionMove(5, S1, 'exited', 'quiet', 'ended')).sessions[S1]?.parkAsked).toBe(
      null,
    );
    expect(
      reduce(s, sessionMove(5, S1, 'host-dead', 'quiet', 'lost')).sessions[S1]?.parkAsked,
    ).toBe(null);
    // Без сессии просить паузу не у кого — аномалия, состояние не тронуто.
    const orphan = reduce(s, signal(6, { action: 'pause-at-safe-point' }, {}));
    expect(orphan.anomalies.at(-1)?.reason).toBe(
      'signal waste-reread: pause-at-safe-point without session',
    );
  });

  it('stop-step: action stop-step stops the step, a row without action stops by severity stop, a pause or show with severity stop does not', () => {
    const base = [
      line(1, 'task.created', {
        title: 't',
        repos: [],
        build: 'b',
        scenario: SCEN,
        profilePins: [],
        modelCeiling: null,
        userLayerHash: null,
        envPin: '',
        requirementsSource: 'text',
        allowedRoutes: [],
        routesSourceLevel: 2,
        origin: null,
        launchPolicy: 'auto',
        ciWait: false,
      }),
      line(2, 'task.transition', { taskId: TASK, event: 'launch', from: 'draft', to: 'running' }),
      line(3, 'unit.created', {
        unitId: UNIT,
        name: 'api',
        repoKey: 'r1',
        branch: 'agentdeck/x',
        ownedPaths: ['src/**'],
        after: [],
        contract: true,
        splitId: null,
      }),
      line(4, 'step.started', {
        stepId: STEP,
        unitId: UNIT,
        stepKind: 'work',
        stepDefId: 'work',
        round: 0,
        scenario: SCEN,
        budgetMs: 60_000,
      }),
      started(5, S1),
    ];
    const s = fold([
      ...base,
      signal(
        6,
        { signal: 'waste-poll', severity: 'warn', action: 'stop-step', subject: 'sleep' },
        {
          stepId: STEP,
        },
      ),
      signal(7, { signal: 'protected-root', severity: 'stop', subject: '/main' }, { stepId: STEP }),
      signal(
        8,
        { signal: 'context-growth', severity: 'stop', action: 'pause-at-safe-point', subject: 'c' },
        { stepId: STEP, sessionId: S1 },
      ),
      signal(9, { signal: 'waste-big-read', severity: 'warn', action: 'show' }, { stepId: STEP }),
      // Действие названо — решает оно, не серьёзность: `stop` + `show` только показан.
      signal(10, { signal: 'stall', severity: 'stop', action: 'show' }, { stepId: STEP }),
    ]);
    expect(s.steps[STEP]?.stops).toEqual(['waste-poll: sleep', 'protected-root: /main']);
    expect(s.anomalies).toEqual([]);
  });
});
