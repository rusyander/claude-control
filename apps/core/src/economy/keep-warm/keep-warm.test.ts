import { describe, expect, it } from 'vitest';
import { CACHE_TTL_LONG_MS, CACHE_TTL_SHORT_MS } from '../cost.ts';
import { KEEP_WARM_MAX_PINGS, KEEP_WARM_WORD, decideKeepWarm } from './index.ts';
import type { KeepWarmInput } from './keep-warm.types.ts';

/**
 * Прогрев (G8): стоящая сессия, кэш на 50-й минуте из 60, пинг дешевле переписи окна — один ход
 * с постоянным словом. Никогда в маршрут, который окно держит или исчерпало (P122); переходник
 * без продолжения сеанса — не предлагается вовсе.
 */

const MIN = 60_000;
const input = (over: Partial<KeepWarmInput> = {}): KeepWarmInput => ({
  now: 52 * MIN,
  session: { parked: true, lastTurnAt: 0, contextTokens: 80_000, cacheTtlMs: CACHE_TTL_LONG_MS },
  adapterResume: true,
  window: 'open',
  pings: { count: 0, lastPingAt: null },
  ...over,
});
const session = (over: Partial<KeepWarmInput['session']>) => ({ ...input().session, ...over });

describe('G8 decideKeepWarm', () => {
  it('parked, 52 of 60 min, open route, resume declared → one ping with the platform word', () => {
    const got = decideKeepWarm(input());
    expect(got).toMatchObject({ kind: 'ping', word: KEEP_WARM_WORD });
    expect(got.numbers.pingCost as number).toBeLessThan(got.numbers.rewriteCost as number);
  });

  const skips: [string, Partial<KeepWarmInput>, string][] = [
    ['a running session', { session: session({ parked: false }) }, 'not-parked'],
    ['no resume on the adapter', { adapterResume: false }, 'no-resume'],
    ['held route', { window: 'held' }, 'route-held'],
    ['exhausted route', { window: 'exhausted' }, 'route-held'],
    ['unknown window', { window: null }, 'route-not-open'],
    ['no turns', { session: session({ lastTurnAt: null }) }, 'no-turns'],
    ['no cache', { session: session({ cacheTtlMs: null }) }, 'no-cache'],
    [
      '5 min cache',
      { session: session({ cacheTtlMs: CACHE_TTL_SHORT_MS }), now: 4.5 * MIN },
      'ttl-short',
    ],
    ['expired cache', { now: 61 * MIN }, 'cold'],
    ['young cache', { now: 40 * MIN }, 'not-yet'],
    ['cap reached', { pings: { count: KEEP_WARM_MAX_PINGS, lastPingAt: null } }, 'cap'],
    ['last ping 2 min ago', { pings: { count: 1, lastPingAt: 50 * MIN } }, 'not-yet'],
    ['tiny context', { session: session({ contextTokens: 10 }) }, 'not-cheaper'],
  ];
  for (const [name, over, reason] of skips)
    it(`skips: ${name} → ${reason}`, () => {
      expect(decideKeepWarm(input(over))).toMatchObject({ kind: 'skip', reason });
    });
});
