import { describe, expect, it } from 'vitest';
import type { ProjectScenario, Scenario, StepDef } from '@agentdeck/contracts/core/scenario';
import { overlayScenario } from './overlay.ts';
import { presetOf, presetStep } from './presets.ts';
import type { NarrowLevel } from './scenario.types.ts';

/**
 * P65: уровни 4 (проект) и 5 (слой пользователя) только сужают — по каждому ключу таблицы
 * порядка (CD§1) узкое значение принято, широкое отвергнуто с путём и причиной; уровень 3
 * отвергается лишь за нарушение правил платформы.
 */

const FEATURE = presetOf({ id: 'feature', version: 1 }) as Scenario;
const WORK = FEATURE.steps.find((s) => s.id === 'work') as StepDef;

/** База с заданными пределами, чтобы и сужение, и расширение каждого числового ключа было видно. */
const BASE: Scenario = {
  ...FEATURE,
  steps: FEATURE.steps.map((s) =>
    s.id === 'work'
      ? {
          ...s,
          roundCap: 2,
          budget: { tokens: 1000, minutes: 30 },
          checks: { mid: 'narrow', required: ['unit-tests'] },
          model: {
            tier: 'ceiling',
            routes: [
              {
                adapter: 'claude',
                route: { kind: 'cli-login', id: 'cli-login-claude' },
                modelPattern: '*',
              },
            ],
          },
          // `on` — самое узкое (хуки и навыки человека остаются); шире — `observe`/`off`.
          userLayer: { hooks: 'observe', skills: 'on' },
          overBudget: 'ask',
          gate: [{ kind: 'requirements-covered' }],
        }
      : s,
  ),
};

const ROUTE = BASE.steps.find((s) => s.id === 'work')?.model.routes?.[0];
const OTHER_ROUTE = {
  adapter: 'qwen',
  route: { kind: 'local', id: 'local-own' },
  modelPattern: '*',
};

/** Ключ таблицы, узкое и широкое значения сужения шага `work`. */
const ROWS: { key: string; narrow: ProjectScenario['steps']; wide: ProjectScenario['steps'] }[] = [
  {
    key: 'checks.mid',
    narrow: { work: { checks: { mid: 'narrow' } } },
    wide: { work: { checks: { mid: 'none' } } },
  },
  {
    key: 'checks.required',
    narrow: { work: { checks: { required: ['unit-tests', 'lint'] } } },
    wide: { work: { checks: { required: [] } } },
  },
  { key: 'roundCap', narrow: { work: { roundCap: 1 } }, wide: { work: { roundCap: 5 } } },
  {
    key: 'budget.tokens',
    narrow: { work: { budget: { tokens: 500 } } },
    wide: { work: { budget: { tokens: 5000 } } },
  },
  {
    key: 'budget.minutes',
    narrow: { work: { budget: { minutes: 10 } } },
    wide: { work: { budget: { minutes: 90 } } },
  },
  {
    key: 'overBudget',
    narrow: { work: { overBudget: 'stop' } },
    wide: { work: { overBudget: 'once-more' } },
  },
  {
    key: 'model.tier',
    narrow: { work: { model: { tier: 'lower-if-mechanical' } } },
    wide: { work: { model: { tier: 'raise-for-planning' } } },
  },
  {
    key: 'model.routes',
    narrow: { work: { model: { routes: ROUTE ? [ROUTE] : [] } } },
    wide: { work: { model: { routes: [...(ROUTE ? [ROUTE] : []), OTHER_ROUTE as never] } } },
  },
  {
    key: 'userLayer.hooks',
    narrow: { work: { userLayer: { hooks: 'on' } } },
    wide: { work: { userLayer: { hooks: 'off' } } },
  },
  {
    key: 'userLayer.skills',
    narrow: { work: { userLayer: { skills: 'on' } } },
    wide: { work: { userLayer: { skills: 'off' } } },
  },
  {
    key: 'gate',
    narrow: {
      work: {
        gate: [{ kind: 'requirements-covered' }, { kind: 'text', criterion: 'docs updated' }],
      },
    },
    wide: { work: { gate: [] } },
  },
];

const layer = (level: NarrowLevel, steps: ProjectScenario['steps']) => ({
  level,
  source: level === 4 ? 'r1: .agentdeck/scenario.json' : 'user layer',
  file: { v: 1 as const, steps },
});

describe('overlayScenario (P65)', () => {
  for (const level of [4, 5] as const) {
    for (const row of ROWS) {
      it(`level ${level} ${row.key}: narrowing applied, widening rejected with path and reason`, () => {
        const narrow = overlayScenario(BASE, [layer(level, row.narrow)]);
        expect(narrow.refused).toBe(false);
        expect(narrow.rejected).toEqual([]);
        expect(narrow.applied.map((e) => [e.level, e.path])).toEqual([
          [level, `steps.work.${row.key}`],
        ]);
        const wide = overlayScenario(BASE, [layer(level, row.wide)]);
        expect(wide.applied).toEqual([]);
        expect(wide.rejected).toHaveLength(1);
        expect(wide.rejected[0]).toMatchObject({ level, path: `steps.work.${row.key}` });
        expect(wide.rejected[0]?.reason).toMatch(/widening/);
        expect(wide.scenario).toEqual(BASE);
      });
    }
  }

  it('level 3: a platform violation refuses the scenario; a sound one passes untouched', () => {
    const noGate: Scenario = {
      ...FEATURE,
      steps: FEATURE.steps
        .filter((s) => s.id !== 'final-gate')
        .map((s) => (s.id === 'publish' ? { ...s, after: ['fix'] } : s)),
    };
    const refused = overlayScenario(noGate, []);
    expect(refused.refused).toBe(true);
    expect(refused.rejected.map((e) => [e.level, e.reason])).toEqual([
      [3, 'platform rule: publish: publish without a final-gate before it'],
      [3, 'platform rule: answer-reviewers: answer-reviewers without a final-gate before it'],
    ]);
    const fine = overlayScenario(FEATURE, []);
    expect(fine).toEqual({
      scenario: FEATURE,
      applied: [],
      rejected: [],
      refused: false,
      precedence: [],
    });
  });

  it('ciWait in a file is rejected and named; unknown step id rejected; * narrows every step', () => {
    const got = overlayScenario(BASE, [
      {
        level: 4,
        source: 'r1',
        file: { v: 1, ciWait: true, steps: { nope: { roundCap: 1 }, '*': { roundCap: 0 } } },
      },
    ]);
    expect(got.rejected.map((e) => e.path)).toEqual(['ciWait', 'steps.nope']);
    expect(got.applied).toHaveLength(BASE.steps.length);
    expect(got.scenario.steps.every((s) => s.roundCap === 0)).toBe(true);
  });

  it('insert: a check step is spliced after its predecessor; a work step is rejected', () => {
    const check = presetStep('extra-check', 'check', 'Доп. проверка', ['work']);
    const work = presetStep('extra-work', 'work', 'Ещё работа', ['work']);
    const got = overlayScenario(FEATURE, [
      { level: 4, source: 'r1', file: { v: 1, insert: [check, work] } },
    ]);
    expect(got.applied.map((e) => e.path)).toEqual(['insert.extra-check']);
    expect(got.rejected.map((e) => e.path)).toEqual(['insert.extra-work']);
    const review = got.scenario.steps.find((s) => s.id === 'review');
    expect(review?.after).toEqual(['work', 'extra-check']);
    expect(WORK.id).toBe('work');
  });

  it('level 4 applies before level 5 whatever the layer order', () => {
    const got = overlayScenario(BASE, [
      layer(5, { work: { roundCap: 0 } }),
      layer(4, { work: { roundCap: 1 } }),
    ]);
    expect(got.applied.map((e) => [e.level, e.value])).toEqual([
      [4, 1],
      [5, 0],
    ]);
  });
});
