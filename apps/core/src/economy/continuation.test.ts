import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { CONTEXT_FRESH_SHARE } from '../lib/context-share.ts';
import { continuationNumbers, decideContinuation, numbersRecord } from './continuation.ts';
import type {
  ContinuationFacts,
  ContinuationInput,
  ContinuationSession,
} from './continuation.types.ts';
import { CACHE_TTL_LONG_MS, CACHE_TTL_SHORT_MS, RELATIVE_RATES } from './cost.ts';
import { sessionCacheFacts } from './session-facts.ts';

/**
 * Судья `continuation` (03:150-155): числа в каждом решении (P14), новый сеанс без выбора (P15),
 * смена маршрута — кэш холодный (P119). Возраст кэша — от стены последнего хода.
 */

const LOGIN = { kind: 'cli-login' as const, id: 'cli-login-claude' };
const KEY = { kind: 'api-key' as const, id: 'anthropic-key' };
const S1 = '01920000-0000-7000-8000-0000000000d1';

const session = (over: Partial<ContinuationSession> = {}): ContinuationSession => ({
  sessionId: 's1',
  stepDefId: 'work',
  state: 'live',
  adapter: 'claude',
  route: LOGIN,
  startedSeq: 5,
  ...over,
});

const MIN = 60_000;
const facts = (over: Partial<ContinuationFacts> = {}): ContinuationFacts => ({
  now: 10 * MIN,
  lastTurnAt: 8 * MIN,
  contextTokens: 40_000,
  cacheTtlMs: CACHE_TTL_SHORT_MS,
  windowTokens: 200_000,
  baseTokens: 20_000,
  briefTokens: 2_000,
  expectedTurns: 1,
  orientationTurns: 0,
  ...over,
});

const next = { adapter: 'claude', route: LOGIN };
const decide = (over: Partial<ContinuationInput> = {}) =>
  decideContinuation({ stepDefId: 'work', next, sessions: [session()], facts: facts(), ...over });

describe('G7 decideContinuation', () => {
  it('a live session of the same step on the same route continues; the latest one is chosen', () => {
    expect(
      decide({
        sessions: [session(), session({ sessionId: 's2', state: 'quiet', startedSeq: 9 })],
      }),
    ).toMatchObject({ mode: 'same-session', sessionId: 's2', basis: 'modelled' });
  });

  it('fresh with the reason: no live session, another step, another route (cache counted cold)', () => {
    expect(decide({ sessions: [session({ state: 'ended' })] })).toMatchObject({
      mode: 'fresh',
      reason: 'no-live-session',
    });
    expect(decide({ stepDefId: 'review' })).toMatchObject({ reason: 'no-live-session' });
    const route = decide({ next: { ...next, route: KEY } });
    expect(route).toMatchObject({
      mode: 'fresh',
      reason: 'route-changed',
      numbers: { cacheWarm: false },
    });
  });

  it('an ended session continues only with its transcript on disk; a lost one never does', () => {
    const ended = [session({ state: 'ended' })];
    expect(decide({ sessions: ended, transcriptPresent: true })).toMatchObject({
      mode: 'same-session',
      sessionId: 's1',
    });
    // Транскрипт неизвестен — продолжать нечем доказанно: новый сеанс, а не догадка.
    expect(decide({ sessions: ended })).toMatchObject({ mode: 'fresh', reason: 'no-live-session' });
    expect(
      decide({ sessions: [session({ state: 'lost' })], transcriptPresent: true }),
    ).toMatchObject({ mode: 'fresh', reason: 'no-live-session' });
  });

  it('no facts measured yet → zeros, continuation is not dearer, and the decision says so', () => {
    const got = decide({ facts: undefined });
    expect(got).toMatchObject({ mode: 'same-session', numbers: { continueCost: 0, freshCost: 0 } });
    expect(got.reasons).toContain('no usage measured yet: numbers are zero');
  });
});

describe('P14 continuation numbers: every decision carries the 03:151-152 costs', () => {
  it('warm cache: continue = context × read; fresh = (base + brief) × write + orientation turns', () => {
    const n = continuationNumbers(facts({ orientationTurns: 3, turnCost: 1_000 }));
    expect(n).toMatchObject({
      cacheWarm: true,
      cacheAgeMs: 2 * MIN,
      continueCost: Math.round(40_000 * RELATIVE_RATES.read),
      freshCost: Math.round(22_000 * RELATIVE_RATES.write + 3 * 1_000),
    });
  });

  it('a cache older than its TTL is cold: the context is rewritten at the write rate', () => {
    const cold = continuationNumbers(facts({ lastTurnAt: 0, now: 6 * MIN }));
    expect(cold).toMatchObject({
      cacheWarm: false,
      continueCost: Math.round(40_000 * RELATIVE_RATES.write),
    });
    // Часовой срок: та же пауза — кэш тёплый, запись часовая дороже.
    const long = continuationNumbers(
      facts({ lastTurnAt: 0, now: 6 * MIN, cacheTtlMs: CACHE_TTL_LONG_MS }),
    );
    expect(long).toMatchObject({
      cacheWarm: true,
      continueCost: Math.round(40_000 * RELATIVE_RATES.read),
    });
    expect(
      continuationNumbers(
        facts({ lastTurnAt: 0, now: 6 * MIN, cacheTtlMs: CACHE_TTL_LONG_MS }),
        true,
      ),
    ).toMatchObject({
      cacheWarm: false,
      continueCost: Math.round(40_000 * RELATIVE_RATES.write1h),
    });
  });

  it('priced rates of the route × model (ratesOf) replace the relative ones', () => {
    const rates = { input: 1, read: 0.2, write: 1.5, write1h: 2.5, output: 4 };
    expect(continuationNumbers(facts({ rates }))).toMatchObject({
      continueCost: 40_000 * 0.2,
      freshCost: 22_000 * 1.5,
    });
  });

  it('several turns ahead: the later turns read the context, the cheaper one wins', () => {
    const big = facts({
      contextTokens: 100_000,
      expectedTurns: 5,
      lastTurnAt: 0,
      now: 30 * MIN,
    });
    const got = decide({ facts: big });
    expect(got).toMatchObject({ mode: 'fresh', reason: 'cheaper-fresh' });
    expect(got.numbers.continueCost).toBeGreaterThan(got.numbers.freshCost);
    expect(numbersRecord(got.numbers)).toMatchObject({ cacheWarm: 0, expectedTurns: 5 });
    expect(numbersRecord(continuationNumbers({ ...big, lastTurnAt: null }))).toMatchObject({
      cacheAgeMs: -1,
    });
  });
});

describe('P15 forced fresh: never continued, whatever the numbers', () => {
  // Числа во всех четырёх строках за продолжение (тёплый маленький кэш): решает только факт.
  const cheap = facts({ contextTokens: 1_000 });
  const cases: { name: string; over: Partial<ContinuationInput>; reason: string }[] = [
    { name: 'another CLI', over: { next: { adapter: 'qwen', route: LOGIN } }, reason: 'other-cli' },
    {
      name: 'transcript missing',
      over: { transcriptPresent: false },
      reason: 'transcript-missing',
    },
    {
      name: 'context over 60% of the model window',
      over: { facts: facts({ contextTokens: 120_001, windowTokens: 200_000 }) },
      reason: 'context-over-60',
    },
    { name: 'unit done', over: { unitState: 'done' }, reason: 'unit-closed' },
    { name: 'unit conditional', over: { unitState: 'conditional' }, reason: 'unit-closed' },
    { name: 'unit closed', over: { unitState: 'closed' }, reason: 'unit-closed' },
  ];
  for (const c of cases)
    it(c.name, () => {
      const got = decide({ facts: cheap, ...c.over });
      expect(got).toMatchObject({
        mode: 'fresh',
        reason: c.reason,
        numbers: { forced: c.reason, cacheWarm: false },
      });
      expect(got.reasons[0]).toMatch(new RegExp(`^forced fresh \\(${c.reason}\\)`));
    });

  it('exactly 60% of the window still continues; an unknown window never forces', () => {
    expect(
      decide({ facts: facts({ contextTokens: CONTEXT_FRESH_SHARE * 200_000 }) }),
    ).toMatchObject({
      mode: 'same-session',
    });
    expect(
      // Остывший кэш 190k без окна: дороже нового — но по числам, не по правилу 60 %.
      decide({ facts: facts({ contextTokens: 190_000, windowTokens: null, lastTurnAt: 0 }) }),
    ).toMatchObject({ mode: 'fresh', reason: 'cheaper-fresh' });
    expect(decide({ unitState: 'in-progress', transcriptPresent: true })).toMatchObject({
      mode: 'same-session',
    });
  });
});

const usage = (at: number, data: Partial<JournalLine<'turn.usage'>['data']>): JournalLine =>
  ({
    v: 1,
    seq: at,
    at,
    mono: at,
    bootId: 'b',
    taskId: 't',
    kind: 'turn.usage',
    actor: 'core',
    data: {
      sessionId: S1,
      messageId: `m${at}`,
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 5,
      routeId: 'cli-login-claude',
      model: 'm',
      subagent: false,
      parentSessionId: null,
      remainder: false,
      ...data,
    },
  }) as JournalLine;

describe('P14 session cache facts: the age comes from the wall time of the last own turn', () => {
  it('last turn, its context, TTL by the 1h share of the last write; subagents and remainders skipped', () => {
    const lines = [
      usage(1_000, { cacheWrite: 500, cacheWrite1h: 500 }),
      usage(2_000, { cacheRead: 500, cacheWrite: 100 }),
      usage(3_000, { subagent: true, input: 99_999 }),
      usage(4_000, { remainder: true, input: 99_999 }),
      usage(5_000, { sessionId: '01920000-0000-7000-8000-0000000000d2', input: 99_999 }),
    ];
    expect(sessionCacheFacts(lines, S1)).toEqual({
      lastTurnAt: 2_000,
      contextTokens: 610,
      cacheTtlMs: CACHE_TTL_SHORT_MS,
      turns: 2,
    });
    expect(sessionCacheFacts(lines.slice(0, 1), S1).cacheTtlMs).toBe(CACHE_TTL_LONG_MS);
  });

  it('no write: the route fact; no write, no route fact, but reads → 5 min; nothing → null', () => {
    const read = [usage(1_000, { cacheRead: 10 })];
    expect(sessionCacheFacts(read, S1, CACHE_TTL_LONG_MS).cacheTtlMs).toBe(CACHE_TTL_LONG_MS);
    expect(sessionCacheFacts(read, S1).cacheTtlMs).toBe(CACHE_TTL_SHORT_MS);
    expect(sessionCacheFacts([usage(1_000, {})], S1)).toMatchObject({ cacheTtlMs: null, turns: 1 });
    expect(sessionCacheFacts([], S1)).toEqual({
      lastTurnAt: null,
      contextTokens: 0,
      cacheTtlMs: null,
      turns: 0,
    });
  });
});
