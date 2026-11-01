import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { tokenScope } from '../../conductor/next/window.ts';
import { initialState, reduce } from '../../journal/reduce/reduce.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { LearnedStats, LearnedTable, TaskSample } from '../learned/learned.types.ts';
import {
  ESTIMATE_MIN_SAMPLES,
  LEARNED_BUDGET_FACTOR,
  budgetState,
  decideBudget,
  estimateFromHistory,
  spentTokens,
  taskTotals,
  unitCountByCost,
} from './index.ts';
import type { BudgetInput } from './budget.types.ts';

/**
 * Бюджеты (03:156-163, G10): шаг — из сценария, иначе выученный p90 × 1.5; токены бюджета —
 * вход + запись кэша + выход; минуты — активное время. Оценка до запуска — из истории с разбросом.
 */

const stats = (over: Partial<LearnedStats> = {}): LearnedStats => ({
  runs: 4,
  failures: 0,
  loweredFailures: 0,
  p90Tokens: 10_000,
  p90Minutes: 6,
  medianTurns: 5,
  ...over,
});

const input = (over: Partial<BudgetInput> = {}): BudgetInput => ({
  scope: 'step:s1',
  scenario: {},
  learned: stats(),
  used: { tokens: 0, activeMs: 0 },
  overBudget: 'ask',
  ...over,
});

describe('G10 decideBudget', () => {
  it('scenario budget first; without it the learned p90 × 1.5', () => {
    expect(decideBudget(input({ scenario: { tokens: 3_000, minutes: 2 } })).limits).toEqual({
      tokens: { value: 3_000, source: 'scenario' },
      minutes: { value: 2, source: 'scenario' },
    });
    expect(LEARNED_BUDGET_FACTOR).toBe(1.5);
    expect(decideBudget(input()).limits).toEqual({
      tokens: { value: 15_000, source: 'learned' },
      minutes: { value: 9, source: 'learned' },
    });
  });

  it('no scenario, no runs → no limit, never over', () => {
    const got = decideBudget(
      input({ learned: stats({ runs: 0 }), used: { tokens: 1e9, activeMs: 1e9 } }),
    );
    expect(got).toMatchObject({
      over: [],
      action: null,
      limits: { tokens: { value: null, source: 'none' } },
    });
    expect(decideBudget(input({ learned: null })).numbers.tokensLimit).toBe(-1);
  });

  it('over a limit → the scenario action; active minutes, not wall time', () => {
    const got = decideBudget(input({ used: { tokens: 15_001, activeMs: 9 * 60_000 } }));
    expect(got).toMatchObject({ over: ['tokens'], action: 'ask' });
    expect(got.reasons[2]).toBe('over budget (tokens): ask');
    expect(budgetState(got)).toEqual({ scope: 'tokens:step:s1', spent: 15_001, limit: 15_000 });
    expect(decideBudget(input({ used: { tokens: 0, activeMs: 9.5 * 60_000 } })).over).toEqual([
      'minutes',
    ]);
  });

  it('a tokens budget.state never moves the step minutes: its scope is the token one the executor reads', () => {
    const task = newId();
    const step = newId();
    const at = (seq: number, kind: JournalKind, data: unknown): JournalLine =>
      ({
        v: 1,
        seq,
        at: seq,
        mono: seq,
        bootId: task,
        taskId: task,
        kind,
        actor: 'core',
        data,
      }) as JournalLine;
    const d = decideBudget(input({ scope: `step:${step}`, used: { tokens: 15_001, activeMs: 0 } }));
    const s = [
      at(1, 'step.started', {
        stepId: step,
        unitId: newId(),
        stepKind: 'work',
        stepDefId: 'work',
        round: 0,
        scenario: { id: 'f', version: 1 },
        budgetMs: 60_000,
      }),
      at(2, 'budget.state', budgetState(d)),
    ].reduce(reduce, initialState(task));
    // Срок шага (минуты, этап 4) не тронут, а токены лежат там, где их ищет исполнитель.
    expect(s.steps[step]).toMatchObject({ budgetMs: 60_000, extensions: 0 });
    expect(s.budgets[tokenScope(step)]).toMatchObject({ spent: 15_001, limit: 15_000 });
  });

  it('budget tokens = input + cache write + output; cache read is spend, not budget', () => {
    expect(
      spentTokens([
        { input: 10, cacheRead: 1_000_000, cacheWrite: 20, cacheWrite1h: 5, output: 30 },
        { input: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1 },
      ]),
    ).toBe(62);
  });

  it('task totals and units by cost: the base context is paid by every unit', () => {
    expect(
      taskTotals(
        [
          { tokens: 5, activeMs: 60_000 },
          { tokens: 7, activeMs: 120_000 },
        ],
        3,
      ),
    ).toEqual({
      tokens: 12,
      minutes: 3,
      sessions: 3,
      steps: 2,
    });
    // 100k работы, база 20k, предел 60k на единицу: 3 единицы (33k + 20k), не 2 (50k + 20k).
    expect(
      unitCountByCost({
        workTokens: 100_000,
        baseTokens: 20_000,
        unitCapTokens: 60_000,
        maxUnits: 10,
      }),
    ).toEqual({ units: 3, totalTokens: 160_000 });
    expect(
      unitCountByCost({
        workTokens: 100_000,
        baseTokens: 70_000,
        unitCapTokens: 60_000,
        maxUnits: 10,
      }),
    ).toBeNull();
  });
});

const task = (over: Partial<TaskSample>): TaskSample => ({
  taskId: 't',
  projects: ['a'],
  scenarioId: 'default',
  tokens: 100,
  activeMs: 60_000,
  outcome: 'done',
  ...over,
});
const table = (tasks: TaskSample[]): LearnedTable => ({ byKey: {}, byKind: {}, tasks, skipped: 0 });

describe('G10 estimateFromHistory', () => {
  it('median with a [p10, p90] spread of the same scenario; cancelled tasks never count', () => {
    const tasks = [100, 200, 300, 400, 500].map((tokens) =>
      task({ tokens, activeMs: tokens * 600 }),
    );
    expect(
      estimateFromHistory(table([...tasks, task({ tokens: 1e9, outcome: 'cancelled' })]), {
        scenarioId: 'default',
        projects: ['a'],
      }),
    ).toEqual({ tokens: 300, minutes: 3, spread: [100, 500], basis: 'history' });
  });

  it('the same projects first; fewer than the minimum → every project of the scenario', () => {
    const own = Array.from({ length: ESTIMATE_MIN_SAMPLES }, () => task({ tokens: 10 }));
    // Чужих проектов больше: в общем пуле медиана — их, в своём — своя.
    const other = Array.from({ length: 3 }, () => task({ projects: ['b'], tokens: 1_000 }));
    expect(
      estimateFromHistory(table([...own, ...other]), { scenarioId: 'default', projects: ['a'] })
        .tokens,
    ).toBe(10);
    expect(
      estimateFromHistory(table([...own.slice(1), ...other]), {
        scenarioId: 'default',
        projects: ['a'],
      }).tokens,
    ).toBe(1_000);
  });

  it('no history of the scenario → no-history with nulls, never a guess', () => {
    expect(
      estimateFromHistory(table([task({ scenarioId: 'other' })]), {
        scenarioId: 'default',
        projects: [],
      }),
    ).toEqual({ tokens: null, minutes: null, spread: null, basis: 'no-history' });
  });
});
