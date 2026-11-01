import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { sentOf, usageOf, windowOf } from './fold-view.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка v7 (план s5 §1): расход хода ЗАМЕНЯЕТСЯ по messageId (P43: итог = сумма последних строк,
 * никогда не сумма повторов), остаток хода ходом не считается, подагент — в сессии-родителе и
 * отдельно; окно — на пару «маршрут × вид предела»; бюджеты по областям; отданные секции.
 */

const TASK = newId();
const BOOT = newId();
const STEP = newId();
const STEP2 = newId();
const S1 = newId();
const S2 = newId();
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function line(seq: number, kind: JournalKind, data: unknown): JournalLine {
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
  } as JournalLine;
}

function fold(lines: JournalLine[]): TaskFoldState {
  return lines.reduce(reduce, initialState(TASK));
}

const started = (seq: number, sessionId: string, stepId: string) =>
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

interface Row {
  sessionId?: string;
  messageId: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  output?: number;
  subagent?: boolean;
  parentSessionId?: string | null;
  remainder?: boolean;
}

const usage = (seq: number, r: Row) =>
  line(seq, 'turn.usage', {
    sessionId: r.sessionId ?? S1,
    messageId: r.messageId,
    input: r.input ?? 0,
    cacheRead: r.cacheRead ?? 0,
    cacheWrite: r.cacheWrite ?? 0,
    cacheWrite1h: r.cacheWrite1h ?? 0,
    output: r.output ?? 0,
    routeId: 'cli-login:claude',
    model: 'stub-model',
    subagent: r.subagent ?? false,
    parentSessionId: r.parentSessionId ?? null,
    remainder: r.remainder ?? false,
  });

const SESSIONS = [started(1, S1, STEP), started(2, S2, STEP2)];

describe('reduce v7 (stage 5 fold, plan s5 §1)', () => {
  it('P43 a repeated messageId REPLACES its row: totals equal the last rows, never their sum', () => {
    const s = fold([
      ...SESSIONS,
      usage(3, { messageId: 'm1', input: 10, output: 2 }),
      // Тот же ход дорос (дельта после `message_stop`): строка заменяет прежнюю.
      usage(4, { messageId: 'm1', input: 10, output: 7, cacheWrite: 4, cacheWrite1h: 3 }),
      usage(5, { messageId: 'm2', input: 1, cacheRead: 100, output: 1 }),
      // Хост сессии после переподключения отдал поток заново — та же строка, итог тот же.
      usage(6, { messageId: 'm2', input: 1, cacheRead: 100, output: 1 }),
    ]);
    expect(s.reducer).toBe(REDUCER_VERSION);
    // Свёртка v7 входит во все следующие версии (v8 — публикатор этапа 6).
    expect(REDUCER_VERSION).toBeGreaterThanOrEqual(7);
    expect(s.anomalies).toEqual([]);
    const want = { input: 11, cacheRead: 100, cacheWrite: 4, cacheWrite1h: 3, output: 8, turns: 2 };
    expect(usageOf(s, 'task')).toEqual(want);
    expect(usageOf(s, `session:${S1}`)).toEqual(want);
    expect(usageOf(s, `step:${STEP}`)).toEqual(want);
    expect(usageOf(s, `session:${S2}`).turns).toBe(0);
  });

  it('the same messageId in two sessions is two turns (key is session × message)', () => {
    const s = fold([
      ...SESSIONS,
      usage(3, { messageId: 'm1', input: 5 }),
      usage(4, { sessionId: S2, messageId: 'm1', input: 7 }),
    ]);
    expect(usageOf(s, 'task')).toMatchObject({ input: 12, turns: 2 });
    expect(usageOf(s, `step:${STEP2}`)).toMatchObject({ input: 7, turns: 1 });
  });

  it('a remainder row adds tokens but no turn; a subagent row lands in its parent and in subagents', () => {
    const s = fold([
      ...SESSIONS,
      usage(3, { messageId: 'm1', input: 10, output: 5 }),
      usage(4, { messageId: 'sub1', input: 3, output: 2, subagent: true, parentSessionId: S1 }),
      usage(5, { messageId: 'result:r1', input: 4, output: 1, remainder: true }),
    ]);
    expect(usageOf(s, 'task')).toMatchObject({ input: 17, output: 8, turns: 2 });
    expect(usageOf(s, `session:${S1}`)).toMatchObject({ input: 17, turns: 2 });
    expect(usageOf(s, 'subagents')).toMatchObject({ input: 3, output: 2, turns: 1 });
  });

  it('turn.usage of an unknown session, or a row changing owner, is an anomaly, not applied', () => {
    const s = fold([
      ...SESSIONS,
      usage(3, { sessionId: newId(), messageId: 'm1', input: 9 }),
      usage(4, { messageId: 'm2', input: 1 }),
      usage(5, { messageId: 'm2', input: 1, subagent: true, parentSessionId: S1 }),
    ]);
    expect(s.anomalies.map((a) => a.seq)).toEqual([3, 5]);
    expect(usageOf(s, 'task')).toMatchObject({ input: 1, turns: 1 });
    expect(usageOf(s, 'subagents').turns).toBe(0);
  });

  it('window.state keeps the last verdict per route × limit kind; budgets by scope; sent-set; bases', () => {
    const s = fold([
      ...SESSIONS,
      line(3, 'window.state', {
        routeId: 'r1',
        limitKind: 'window',
        verdict: 'warn',
        resetAt: 5,
      }),
      line(4, 'window.state', { routeId: 'r1', limitKind: 'rate', verdict: 'open', resetAt: null }),
      line(5, 'window.state', {
        routeId: 'r1',
        limitKind: 'window',
        verdict: 'refused',
        resetAt: 9,
      }),
      line(6, 'window.state', { routeId: 'r2', limitKind: 'window', verdict: 'open', resetAt: 1 }),
      line(7, 'budget.state', { scope: 'task', spent: 10, limit: 100 }),
      line(8, 'budget.state', { scope: 'task', spent: 20, limit: 100 }),
      line(9, 'brief.sent', {
        sessionId: S1,
        form: 'brief',
        sections: [
          { id: 'req', sha256: SHA_A, bytes: 10 },
          { id: 'gate', sha256: SHA_A, bytes: 5 },
        ],
      }),
      line(10, 'brief.sent', {
        sessionId: S1,
        form: 'delta',
        sections: [{ id: 'req', sha256: SHA_B, bytes: 11 }],
      }),
      line(11, 'context.base', {
        adapter: 'claude',
        cliVersion: '2.1.286',
        stepKind: 'work',
        layerHash: SHA_A,
        mcpHash: SHA_B,
        bytes: 900,
        tokens: 300,
      }),
    ]);
    expect(s.anomalies).toEqual([]);
    expect(windowOf(s, 'r1')).toEqual([
      { routeId: 'r1', limitKind: 'window', verdict: 'refused', resetAt: 9, seq: 5 },
      { routeId: 'r1', limitKind: 'rate', verdict: 'open', resetAt: null, seq: 4 },
    ]);
    expect(windowOf(s, 'nope')).toEqual([]);
    expect(s.budgets.task).toEqual({ scope: 'task', spent: 20, limit: 100, seq: 8 });
    expect(sentOf(s, S1)).toEqual({ req: SHA_B, gate: SHA_A });
    expect(sentOf(s, S2)).toEqual({});
    expect(s.bases).toHaveLength(1);
  });

  it('a step-scope budget.state still extends the step (stage 4) and is remembered by scope', () => {
    const s = fold([
      ...SESSIONS,
      line(3, 'step.started', {
        stepId: STEP,
        unitId: newId(),
        stepKind: 'work',
        stepDefId: 'work',
        round: 0,
        scenario: { id: 'f', version: 1 },
        budgetMs: 1_000,
      }),
      line(4, 'budget.state', { scope: `step:${STEP}`, spent: 0, limit: 5_000 }),
    ]);
    expect(s.steps[STEP]).toMatchObject({ budgetMs: 5_000, extensions: 1 });
    expect(s.budgets[`step:${STEP}`]).toMatchObject({ limit: 5_000, seq: 4 });
  });

  it('lookups ignore inherited keys (own-property maps)', () => {
    const s = fold(SESSIONS);
    expect(usageOf(s, 'step:constructor')).toMatchObject({ turns: 0 });
    expect(sentOf(s, 'toString')).toEqual({});
  });
});
