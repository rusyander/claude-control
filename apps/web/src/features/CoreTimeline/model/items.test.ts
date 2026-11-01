import { describe, expect, it } from 'vitest';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { SseEvent } from '@entities/CoreTask';
import { foldEvents } from './fold';
import { decisionKeys, timelineItems, tokenTotal } from './items';
import { signalRows } from './signals';

/**
 * Соединение ленты с видом ядра: режим проверки — по id решения из вида (не по тексту), расход
 * шага и сессии — числа ядра (`spendOf`), панель их только раскладывает по строкам.
 */

const TASK = '01900000-0000-7000-8000-000000000001';
const STEP = '01900000-0000-7000-8000-000000000101';
const SESSION = '01900000-0000-7000-8000-000000000501';
const D_RUN = '01900000-0000-7000-8000-000000000601';
const D_REPLAY = '01900000-0000-7000-8000-000000000602';

function ev(seq: number, kind: string, data: unknown, extra: Record<string, unknown> = {}) {
  const line = { v: 1, seq, at: seq, kind, data, ...extra };
  return { id: String(seq), event: kind, data: JSON.stringify(line) } satisfies SseEvent;
}

const usage = (n: number) => ({
  input: n,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: n,
  turns: 1,
});
const cost = (usd: number) => ({ usd, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 1 });

function view(): TaskView {
  return {
    taskId: TASK,
    seq: 9,
    state: 'running',
    ended: null,
    steps: [
      {
        stepId: STEP,
        unitId: STEP,
        stepKind: 'implement',
        stepDefId: 'impl',
        round: 0,
        state: 'running',
        startedSeq: 1,
        budgetMs: 0,
        outcome: null,
        reason: null,
      },
    ],
    sessions: [
      {
        sessionId: SESSION,
        stepId: STEP,
        state: 'running',
        cli: 'claude',
        cliVersion: '2.1.0',
        route: { kind: 'stub', id: 'stub:stand' },
        modelAsked: 'stub-model',
        modelServed: 'stub-model',
        effort: 'high',
        startedSeq: 2,
      },
    ],
    checks: [
      { decisionId: D_RUN, seq: 3, stepId: STEP, mode: 'run', why: 'no record', recordId: null },
      {
        decisionId: D_REPLAY,
        seq: 4,
        stepId: STEP,
        mode: 'replay',
        why: 'tree same',
        recordId: 'r1',
      },
    ],
    asks: [],
    budgets: [],
    windows: [],
    spend: {
      tokens: usage(30),
      cost: cost(0.03),
      bySession: { [SESSION]: { tokens: usage(10), cost: cost(0.01) } },
      byStep: { [STEP]: { tokens: usage(20), cost: cost(0.02) } },
    },
    report: null,
    attention: null,
  } as unknown as TaskView;
}

const fold = foldEvents([
  ev(
    1,
    'step.started',
    { stepId: STEP, unitId: STEP, stepKind: 'implement', stepDefId: 'impl', round: 0 },
    { stepId: STEP },
  ),
  ev(2, 'session.started', { adapter: 'claude' }, { stepId: STEP, sessionId: SESSION }),
  ev(3, 'decision', { decisionId: D_RUN, class: 'check', reasons: ['r'], output: { kind: 'run' } }),
  ev(4, 'decision', {
    decisionId: D_REPLAY,
    class: 'check',
    reasons: [],
    output: { kind: 'replay' },
  }),
  ev(5, 'signal', { signal: 'stall', severity: 'warn', subject: '', detail: '' }),
  ev(6, 'signal', { signal: 'loop', severity: 'stop', subject: '', detail: '' }),
]);

describe('лента и вид ядра', () => {
  it('режим проверки и запись — из вида по id решения: прогон без записи, повтор с записью', () => {
    const checks = timelineItems(fold, view()).filter((i) => i.kind === 'check');
    expect(
      checks.map((c) => (c.kind === 'check' ? [c.check.mode, c.check.recordId] : null)),
    ).toEqual([
      ['run', null],
      ['replay', 'r1'],
    ]);
  });

  it('шаг несёт свои сессии и расход шага ядра, сессия — расход сессии', () => {
    const items = timelineItems(fold, view());
    const step = items.find((i) => i.kind === 'step');
    const session = items.find((i) => i.kind === 'session');
    expect(step?.kind === 'step' && tokenTotal(step.spend!.tokens)).toBe(40);
    expect(step?.kind === 'step' && step.sessions.map((s) => s.sessionId)).toEqual([SESSION]);
    expect(session?.kind === 'session' && session.spend?.cost.usd).toBe(0.01);
  });

  it('без вида проверка остаётся строкой решения, а не выдуманным режимом', () => {
    const items = timelineItems(fold, undefined);
    expect(items.filter((i) => i.kind === 'check')).toHaveLength(0);
    expect(items.find((i) => i.kind === 'step')).toMatchObject({ step: null, spend: null });
  });

  it('сигналы — новыми сверху', () => {
    expect(signalRows(fold).map((s) => s.signal.signal)).toEqual(['loop', 'stall']);
  });

  it('ключи шаблона: класс из реестра — подпись и заголовок, чужой класс или нет исхода — null', () => {
    expect(decisionKeys('check', 'run')).toEqual({
      label: 'coreTimeline.decisions.check.label',
      headline: 'coreTimeline.decisions.check.outcomes.run',
    });
    expect(decisionKeys('nope', 'run')).toBeNull();
    expect(decisionKeys('check', null)).toBeNull();
  });
});
