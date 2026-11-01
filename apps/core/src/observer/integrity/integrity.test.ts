import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { journalLines } from '../__fixtures__/selftest.ts';
import { foldObserver, initObserverFold } from '../fold.ts';
import type { FiredVerdict, PredicateCtx } from '../observer.types.ts';
import {
  CONTEXT_55,
  CONTEXT_RAMP,
  LEAKED_LEASE,
  RELEASED_LEASE,
  RID,
  ROUTE,
  S1,
  STEP,
  sessionStarted,
  usage,
  WINDOW_REFUSAL,
  WINDOW_STEADY,
  WINDOW_TOKENS,
} from './__fixtures__/selftests.ts';
import { journalRejectedVerdict } from './journal-rejected.ts';

/**
 * Предикаты целостности этапа 8 (06:137-140, F10/F11) через настоящую свёртку наблюдателя со
 * ВСЕМИ предикатами реестра: пара «срабатывает / почти-двойник молчит» и края каждого правила.
 */

const ctx = (window: number | null = WINDOW_TOKENS): PredicateCtx => ({
  windowOf: () => window,
  now: () => 0,
});

function fold(lines: readonly JournalLine[], c: PredicateCtx = ctx()): FiredVerdict[] {
  let state = initObserverFold();
  const out: FiredVerdict[] = [];
  for (const line of lines) {
    const step = foldObserver(state, line, c);
    expect(step.errors).toEqual([]);
    state = step.state;
    out.push(...step.verdicts);
  }
  return out;
}

const of = (verdicts: FiredVerdict[], signal: string) =>
  verdicts.filter((v) => v.signal === signal);

const S2 = '01900000-0000-7000-8000-0000000000d2';

describe('integrity resource-leak predicate', () => {
  it('a resource.leak row fires one resource-leak naming the rid', () => {
    const got = of(fold(LEAKED_LEASE), 'resource-leak');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ subject: RID, detail: 'lease release refused: 503' });
  });

  it('near-miss: the same resource released and verified gone stays silent', () => {
    expect(of(fold(RELEASED_LEASE), 'resource-leak')).toEqual([]);
  });

  it('two leak rows are two signals (one per row, keyed by seq)', () => {
    const twice = journalLines([
      ...LEAKED_LEASE.map((l) => ({ kind: l.kind, data: l.data })),
      { kind: 'resource.leak', data: { rid: RID, reason: 'verify failed' } },
    ]);
    expect(of(fold(twice), 'resource-leak').map((v) => v.key)).toEqual([
      'resource-leak:2',
      'resource-leak:3',
    ]);
  });
});

const win = (verdict: string, resetAt: number | null = null, limitKind = 'window') => ({
  kind: 'window.state' as const,
  data: { routeId: ROUTE, limitKind, verdict, resetAt },
});

describe('integrity window predicate', () => {
  it('open → warn is the first step, warn → refused escalates; one signal per transition', () => {
    const got = of(fold(WINDOW_REFUSAL), 'window');
    expect(got.map((v) => [v.detail.split(',')[0], v.escalated])).toEqual([
      ['window: open → warn', false],
      ['window: warn → refused', true],
    ]);
  });

  it('near-miss: the same verdict again with only a new reset time stays silent', () => {
    expect(of(fold(WINDOW_STEADY), 'window')).toEqual([]);
  });

  it('back to open is silent; held, exhausted and offline escalate; pairs are per limit kind', () => {
    const lines = journalLines([
      win('refused'),
      win('refused', 5),
      win('open'),
      win('held'),
      win('exhausted'),
      win('offline'),
      win('warn', null, 'weekly'),
    ]);
    const got = of(fold(lines), 'window');
    expect(got.map((v) => [v.detail, v.escalated])).toEqual([
      ['window: open → refused', true],
      ['window: open → held', true],
      ['window: held → exhausted', true],
      ['window: exhausted → offline', true],
      ['weekly: open → warn', false],
    ]);
  });
});

describe('integrity context-growth predicate', () => {
  it('main-session context past 60 % of the route window fires once, on the step of the session', () => {
    const got = of(fold(CONTEXT_RAMP), 'context-growth');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ subject: S1, sessionId: S1, stepId: STEP, inputs: [4] });
    expect(got[0]?.detail).toContain('65% of window 200000');
  });

  it('near-miss: the same ramp stopping at 55 % stays silent', () => {
    expect(of(fold(CONTEXT_55), 'context-growth')).toEqual([]);
  });

  it('context = input + cacheRead + cacheWrite: 61 % fires, exactly 60 % does not', () => {
    const at = (n: number) => journalLines([sessionStarted(S1), usage(S1, n)]);
    expect(of(fold(at(120_000)), 'context-growth')).toEqual([]);
    expect(of(fold(at(122_000)), 'context-growth')).toHaveLength(1);
  });

  it('subagent and remainder rows never count, however large', () => {
    const lines = journalLines([
      sessionStarted(S1),
      usage(S1, 190_000, { subagent: true }),
      usage(S1, 190_000, { remainder: true }),
    ]);
    expect(of(fold(lines), 'context-growth')).toEqual([]);
  });

  it('an unknown route window is silent', () => {
    expect(of(fold(CONTEXT_RAMP, ctx(null)), 'context-growth')).toEqual([]);
  });

  it('no route window (cli login): the window the session reported judges — 65 % fires naming its source, 55 % stays silent', () => {
    const reported = (n: number) =>
      journalLines([sessionStarted(S1), usage(S1, n, { contextWindow: WINDOW_TOKENS })]);
    const got = of(fold(reported(130_000), ctx(null)), 'context-growth');
    expect(got).toHaveLength(1);
    expect(got[0]?.detail).toContain('65% of window 200000');
    expect(got[0]?.reasons).toContain('window source: reported by the session');
    expect(of(fold(reported(110_000), ctx(null)), 'context-growth')).toEqual([]);
  });

  it('the route window wins over the reported one: 130k is 65 % of a 200k route even when the session reports 1M', () => {
    const lines = journalLines([
      sessionStarted(S1),
      usage(S1, 130_000, { contextWindow: 1_000_000 }),
    ]);
    const got = of(fold(lines), 'context-growth');
    expect(got).toHaveLength(1);
    expect(got[0]?.reasons).toContain('window source: route setting');
    // И наоборот: окно маршрута велико — названное сессией меньшее окно не судит.
    expect(of(fold(lines, ctx(1_000_000)), 'context-growth')).toEqual([]);
  });

  it('the first turn is judged when its row is rewritten with the reported window at the turn result', () => {
    const lines = journalLines([
      sessionStarted(S1),
      usage(S1, 130_000, { messageId: 'm1' }),
      usage(S1, 130_000, { messageId: 'm1', contextWindow: WINDOW_TOKENS }),
    ]);
    const got = of(fold(lines, ctx(null)), 'context-growth');
    expect(got).toHaveLength(1);
    expect(got[0]?.inputs).toEqual([3]);
  });

  it('once per session; a resumed continuation of a fired session is not parked again', () => {
    const lines = journalLines([
      sessionStarted(S1),
      usage(S1, 130_000),
      usage(S1, 150_000),
      sessionStarted(S2, S1),
      usage(S2, 160_000),
    ]);
    expect(of(fold(lines), 'context-growth').map((v) => v.subject)).toEqual([S1]);
  });

  it('a fresh session after the park is judged on its own', () => {
    const lines = journalLines([
      sessionStarted(S1),
      usage(S1, 130_000),
      sessionStarted(S2),
      usage(S2, 130_000),
    ]);
    expect(of(fold(lines), 'context-growth').map((v) => v.subject)).toEqual([S1, S2]);
  });
});

describe('integrity journal-rejected verdict', () => {
  it('names the refused kind, carries the issues capped at 500 chars, keyed per rejection', () => {
    const v = journalRejectedVerdict({ kind: 'signal', issues: ['data.severity: bad'] }, 'r1');
    expect(v).toMatchObject({
      fired: true,
      signal: 'journal-rejected',
      subject: 'signal',
      detail: 'data.severity: bad',
      key: 'journal-rejected:r1',
    });
    const long = journalRejectedVerdict({ kind: 'x', issues: ['y'.repeat(900)] }, 'r2');
    expect(long.fired && long.detail.length).toBe(501);
  });
});
