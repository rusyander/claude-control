import { describe, expect, it } from 'vitest';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { RoutePrice } from '@agentdeck/contracts/core/routes';
import { journalUsage } from '../../bootstrap/economy-wiring/usage.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, fakeClock, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { usageOf } from '../../journal/reduce/fold-view.ts';
import { RELATIVE_RATES } from '../cost.ts';
import { P43_TURNS } from './__fixtures__/p43-turns.ts';
import { priceOf, ratesOf, spendOf, turnsOfLines } from './price.ts';

/**
 * Цена хода (P127): маршрут × версия модели; подписка — единицы окна без денег; неизвестная
 * цена — только токены. Пересчёт расхода из журнала ядра равен аналитике панели (P43, золотой
 * снимок `scanAnalytics` над теми же ходами).
 */

const MONEY: Fact<RoutePrice> = { value: { unit: 'money', source: 'anthropic' } };
const USAGE = { input: 1000, cacheRead: 10_000, cacheWrite: 2000, cacheWrite1h: 500, output: 400 };
const AUG = Date.parse('2026-08-20T00:00:00Z');
const SEP = Date.parse('2026-09-10T00:00:00Z');

describe('economy/price — P127 price by route × model version', () => {
  it('route kinds × model versions: money by version, window units, tokens-only otherwise', () => {
    const rows = {
      'money opus-4-8': priceOf(MONEY, 'claude-opus-4-8', USAGE, SEP),
      'money opus-4-1': priceOf(MONEY, 'claude-opus-4-1-20250805', USAGE, SEP),
      'money sonnet-5 intro': priceOf(MONEY, 'claude-sonnet-5', USAGE, AUG),
      'money sonnet-5 list': priceOf(MONEY, 'claude-sonnet-5', USAGE, SEP),
      'money declared': priceOf(MONEY, 'Corp-Model-1', USAGE, SEP, {
        declared: { 'corp-model-1': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } },
      }),
      'money foreign model': priceOf(MONEY, 'gpt-x', USAGE, SEP),
      'money unknown model': priceOf(MONEY, 'unknown', USAGE, SEP),
      window: priceOf({ value: { unit: 'window' } }, 'claude-opus-4-8', USAGE, SEP),
      'gpu-time': priceOf({ value: { unit: 'gpu-time' } }, 'qwen3', USAGE, SEP),
      none: priceOf({ value: { unit: 'none' } }, 'claude-opus-4-8', USAGE, SEP),
      absent: priceOf({ absent: true }, 'claude-opus-4-8', USAGE, SEP),
      unknown: priceOf({ unknown: 'probe timed out' }, 'claude-opus-4-8', USAGE, SEP),
    };
    expect(rows).toMatchInlineSnapshot(`
      {
        "absent": {
          "reason": "no-price",
          "tokens": 13400,
          "unit": "tokens",
        },
        "gpu-time": {
          "reason": "gpu-time",
          "tokens": 13400,
          "unit": "tokens",
        },
        "money declared": {
          "unit": "money",
          "usd": 0.0051,
          "version": "declared:corp-model-1",
        },
        "money foreign model": {
          "reason": "unknown-price",
          "tokens": 13400,
          "unit": "tokens",
        },
        "money opus-4-1": {
          "unit": "money",
          "usd": 0.103125,
          "version": "claude-opus-4-1",
        },
        "money opus-4-8": {
          "unit": "money",
          "usd": 0.034374999999999996,
          "version": "claude-opus-4-8",
        },
        "money sonnet-5 intro": {
          "unit": "money",
          "usd": 0.01375,
          "version": "claude-sonnet-5..2026-08-31",
        },
        "money sonnet-5 list": {
          "unit": "money",
          "usd": 0.020625,
          "version": "claude-sonnet-5@2026-09-01",
        },
        "money unknown model": {
          "reason": "unknown-model",
          "tokens": 13400,
          "unit": "tokens",
        },
        "none": {
          "reason": "no-price",
          "tokens": 13400,
          "unit": "tokens",
        },
        "unknown": {
          "reason": "unknown-price",
          "tokens": 13400,
          "unit": "tokens",
        },
        "window": {
          "unit": "window",
          "units": 6875,
        },
      }
    `);
  });

  it('a route with money gives its own cache ratios; every other route the shared ones', () => {
    expect(ratesOf(MONEY, 'claude-opus-4-8', SEP)).toEqual({
      input: 1,
      read: 0.1,
      write: 1.25,
      write1h: 2,
      output: 5,
    });
    expect(ratesOf({ value: { unit: 'window' } }, 'claude-opus-4-8', SEP)).toBe(RELATIVE_RATES);
    expect(ratesOf(MONEY, 'gpt-x', SEP)).toBe(RELATIVE_RATES);
  });

  it('spend keeps money, window units and unpriced tokens apart', () => {
    const turns = [
      { routeId: 'api', model: 'claude-opus-4-8', usage: USAGE, at: SEP },
      { routeId: 'sub', model: 'claude-opus-4-8', usage: USAGE, at: SEP },
      { routeId: 'local', model: 'qwen3', usage: USAGE, at: SEP },
    ];
    const priceFor = (routeId: string): Fact<RoutePrice> =>
      routeId === 'api'
        ? MONEY
        : routeId === 'sub'
          ? { value: { unit: 'window' } }
          : { value: { unit: 'gpu-time' } };
    const s = spendOf(turns, priceFor);
    expect(s).toMatchObject({
      turns: 3,
      unpricedTokens: 13_400,
      versions: { 'claude-opus-4-8': 1 },
    });
    expect(s.usd).toBeCloseTo(0.034375, 12);
    expect(s.windowUnits).toBeCloseTo(6875, 12);
  });
});

/** Аналитика панели над транскриптом из `P43_TURNS` (снято однажды, 30.10.2026). */
const PANEL_GOLDEN = {
  overall: { input: 7740, output: 4600, cacheRead: 150_000, cacheCreation: 19_000, requests: 5 },
  estimatedCost: 0.26595,
  byModel: {
    'claude-opus-4-8': 0.17245,
    'claude-sonnet-5': 0.0875,
    'claude-haiku-4-5': 0.006,
  },
};

describe('economy/price — P43 spend recomputed from the core journal equals the panel', () => {
  it('turn.usage lines of a task, priced by version at their moment, give the panel numbers', async () => {
    const ordered = [...P43_TURNS].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let wall = Date.parse(ordered[0]!.at);
    const clock = fakeClock(wall);
    const task = await createTaskRegistry(tempDir('price-p43-'), deps({ clock })).create(CREATED);
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const got = bindingOf(task, sessionId);
    if (!('binding' in got)) throw new Error(got.reason);
    for (const t of ordered) {
      clock.advance(Date.parse(t.at) - wall);
      wall = Date.parse(t.at);
      journalUsage(task, got.binding, { type: 'usage', ...t });
    }

    const turns = turnsOfLines(readJournalLines(task.dir, task.taskId).lines);
    expect(turns).toHaveLength(PANEL_GOLDEN.overall.requests);
    const spend = spendOf(turns, () => MONEY);
    expect(spend.usd).toBeCloseTo(PANEL_GOLDEN.estimatedCost, 12);
    for (const [model, usd] of Object.entries(PANEL_GOLDEN.byModel)) {
      const own = spendOf(
        turns.filter((t) => t.model === model),
        () => MONEY,
      );
      expect(own.usd, model).toBeCloseTo(usd, 12);
    }
    expect(spend.versions).toEqual({
      'claude-opus-4-8': 2,
      'claude-sonnet-5..2026-08-31': 1,
      'claude-sonnet-5@2026-09-01': 1,
      'claude-haiku-4-5': 1,
    });
    // Токены свёртки — те же, что у панели: повтор ответа учтён один раз, полным.
    expect(usageOf(task.state, 'task')).toEqual({
      input: PANEL_GOLDEN.overall.input,
      output: PANEL_GOLDEN.overall.output,
      cacheRead: PANEL_GOLDEN.overall.cacheRead,
      cacheWrite: PANEL_GOLDEN.overall.cacheCreation,
      cacheWrite1h: 8000,
      turns: PANEL_GOLDEN.overall.requests,
    });
  });
});
