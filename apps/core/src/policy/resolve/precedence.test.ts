import { describe, expect, it } from 'vitest';
import { presetOf } from '../../conductor/scenario/presets.ts';
import { overlayScenario } from '../../conductor/scenario/overlay.ts';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import {
  PRECEDENCE_KEYS,
  precedenceDecisionData,
  resolveKey,
  routesPrecedence,
  type PrecedenceKey,
  type PrecedenceValue,
} from './precedence.ts';
import { resolveAllowedRoutes } from './resolve.ts';

/**
 * 06 §Precedence, G1: ОДИН судья старшинства. Каждое расширение уровней 3–5 отвергнуто и названо
 * (источник + почему) этой одной функцией; уровень 2 расширяет; пол уровня 1 не опускает никто;
 * порядок предложений не меняет итог (сортировка по уровню).
 */

const ROUTE_A = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'cli-login-claude' },
  modelPattern: '*',
};
const ROUTE_B = { adapter: 'qwen', route: { kind: 'local', id: 'local-own' }, modelPattern: '*' };

/** Ключ → основа, узкое и широкое значения. */
const TABLE: Record<PrecedenceKey, { base: unknown; narrow: unknown; wide: unknown }> = {
  'model.tier': { base: 'ceiling', narrow: 'lower-if-mechanical', wide: 'raise-for-planning' },
  overBudget: { base: 'ask', narrow: 'stop', wide: 'once-more' },
  'userLayer.hooks': { base: 'observe', narrow: 'on', wide: 'off' },
  // `on` — уже всего: навыки и хуки человека остаются (WIDTH_ORDER, P65).
  'userLayer.skills': { base: 'on', narrow: 'on', wide: 'off' },
  'checks.mid': { base: 'narrow', narrow: 'narrow', wide: 'none' },
  roundCap: { base: 2, narrow: 1, wide: 3 },
  'budget.tokens': { base: 1000, narrow: 500, wide: 2000 },
  'budget.minutes': { base: 30, narrow: 10, wide: 60 },
  'checks.required': { base: ['unit'], narrow: ['unit', 'lint'], wide: [] },
  gate: {
    base: [{ kind: 'requirements-covered' }],
    narrow: [{ kind: 'requirements-covered' }, { kind: 'review-no-blocking' }],
    wide: [],
  },
  'model.routes': { base: [ROUTE_A], narrow: [ROUTE_A], wide: [ROUTE_A, ROUTE_B] },
  humanPoints: { base: ['.claude/**'], narrow: ['.claude/**', 'db/**'], wide: [] },
  ciWait: { base: null, narrow: null, wide: true },
};

/** Ключи, у которых сужение принимается (у `ciWait` и `userLayer.*`-таблицы узкое = основа). */
const base = (key: PrecedenceKey): PrecedenceValue => ({
  level: 3,
  source: 'feature@1',
  value: TABLE[key].base,
});

describe('resolveKey — one precedence judge (06:3-9, G1)', () => {
  it('the table covers every key of the judge', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...PRECEDENCE_KEYS].sort());
  });

  for (const level of [3, 4, 5] as const) {
    it.each(PRECEDENCE_KEYS.filter((k) => k !== 'humanPoints'))(
      `level ${level} %s: widening rejected with source and why; value stays`,
      (key) => {
        const got = resolveKey(key, base(key), [
          { level, source: `L${level} file`, value: TABLE[key].wide },
        ]);
        expect(got.applied).toEqual([]);
        expect(got.rejected).toHaveLength(1);
        expect(got.rejected[0]).toMatchObject({ level, source: `L${level} file` });
        expect(got.rejected[0]?.why).toMatch(/widening|CI wait is the user's live decision/);
        expect(got.value).toEqual(TABLE[key].base);
        expect(got.sourceLevel).toBe(3);
      },
    );
  }

  it.each(PRECEDENCE_KEYS.filter((k) => k !== 'ciWait'))('level 4 %s: narrowing applied', (key) => {
    const got = resolveKey(key, base(key), [{ level: 4, source: 'r1', value: TABLE[key].narrow }]);
    expect(got.rejected).toEqual([]);
    expect(got.value).toEqual(TABLE[key].narrow);
    expect(got).toMatchObject({ sourceLevel: 4, source: 'r1' });
  });

  it('humanPoints below level 2 only unions: a list without the old point keeps it', () => {
    const got = resolveKey('humanPoints', base('humanPoints'), [
      { level: 5, source: 'user', value: ['db/**'] },
    ]);
    expect(got.rejected).toEqual([]);
    expect(got.value).toEqual(['.claude/**', 'db/**']);
    expect(got.applied[0]?.note).toMatch(/keeps 1/);
  });

  it('level 2 (live decision) may widen', () => {
    const got = resolveKey('roundCap', base('roundCap'), [
      { level: 2, source: 'set-scenario', value: 5 },
    ]);
    expect(got).toMatchObject({ value: 5, sourceLevel: 2, rejected: [] });
  });

  it('level 1 floor is never lowered, even by level 2; its own row names it', () => {
    const floor = { source: 'platform', value: 'observe' };
    const got = resolveKey(
      'userLayer.hooks',
      { level: 3, source: 'feature@1', value: 'on' },
      [{ level: 2, source: 'human', value: 'off' }],
      floor,
    );
    expect(got.value).toBe('observe');
    expect(got.sourceLevel).toBe(1);
    expect(got.rejected.map((r) => r.why)).toEqual([
      expect.stringMatching(/below the platform floor/),
    ]);
    const points = resolveKey('humanPoints', { level: 2, source: 'config', value: ['db/**'] }, [], {
      source: 'platform',
      value: ['.claude/**'],
    });
    expect(points.value).toEqual(['.claude/**', 'db/**']);
  });

  it('offers are judged by level whatever the order the road collected them', () => {
    const a = resolveKey('roundCap', base('roundCap'), [
      { level: 5, source: 'user', value: 0 },
      { level: 4, source: 'r1', value: 1 },
    ]);
    // Уровень 4 → 1, затем 5 → 0: оба принят. Обратный порядок судил бы 5 → 0, и 4 → 1 стало бы расширением.
    expect(a.applied.map((r) => [r.level, r.value])).toEqual([
      [4, 1],
      [5, 0],
    ]);
    expect(a.rejected).toEqual([]);
    expect(a.value).toBe(0);
  });
});

describe('routes ride the same decision (G1)', () => {
  it('a level-4 route outside the set is a rejected row of the routes key', () => {
    const resolution = resolveAllowedRoutes({
      launch: [ROUTE_A as never],
      cliLoginOf: () => undefined,
      narrowings: [
        { level: 4, source: 'r1: .agentdeck/scenario.json', routes: [ROUTE_B as never] },
      ],
    });
    const row = routesPrecedence(resolution);
    expect(row.key).toBe('routes');
    expect(row.rejected).toEqual([
      expect.objectContaining({
        level: 4,
        source: 'level 4',
        why: expect.stringMatching(/^r1: \.agentdeck\/scenario\.json: .*only level 2 widens/),
      }),
    ]);
  });
});

describe('overlay calls the judge per leaf; one decision per path', () => {
  const FEATURE = presetOf({ id: 'feature', version: 1 }) as Scenario;

  it('level 4 and 5 rows of one leaf share one decision; data is JSON for the journal', () => {
    const got = overlayScenario(FEATURE, [
      { level: 5, source: 'user', file: { v: 1, steps: { work: { roundCap: 9 } } } },
      { level: 4, source: 'r1', file: { v: 1, steps: { work: { roundCap: 1 } }, ciWait: true } },
    ]);
    const roundCap = got.precedence.find((d) => d.key === 'steps.work.roundCap');
    expect(roundCap?.applied.map((r) => r.level)).toEqual([4]);
    expect(roundCap?.rejected.map((r) => r.level)).toEqual([5]);
    expect(roundCap?.value).toBe(1);
    expect(got.precedence.find((d) => d.key === 'ciWait')?.rejected).toHaveLength(1);
    const data = precedenceDecisionData(got.precedence, []);
    expect(data.class).toBe('precedence');
    expect(data.numbers).toMatchObject({ rejected: 2, applied: 1 });
    expect(JSON.parse(JSON.stringify(data.output))).toEqual(data.output);
  });
});
