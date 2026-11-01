import { describe, expect, it } from 'vitest';
import type { ModelPricing } from '@agentdeck/contracts';
import type { HopPriceSpec } from '@agentdeck/contracts/core/hops';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { RoutePrice } from '@agentdeck/contracts/core/routes';
import { priceOf } from '../economy/price/index.ts';
import { hopPriceOf } from './price.ts';

/**
 * Деньги звена считаются той же ценой, что ход ядра (P127): ветвление повторено в хосте
 * (depcruise `core-hop-host-thin` не пускает его в экономику ядра), поэтому каждая ячейка матрицы
 * «факт × модель × расход × дата» сверяется с `economy/price` — разошлась копия, краснеет здесь.
 */

const MONEY: Fact<RoutePrice> = { value: { unit: 'money', source: 'table' } };
const FACTS: Fact<RoutePrice>[] = [
  MONEY,
  { value: { unit: 'window' } },
  { value: { unit: 'gpu-time' } },
  { value: { unit: 'none' } },
  { absent: true },
  { unknown: 'registry not read' },
];
const DECLARED: Record<string, ModelPricing> = {
  'gw-model': { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0.9, cacheWrite1h: 1.4 },
};
const MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-sonnet-9-preview',
  'GW-Model',
  'qwen3-coder',
  'unknown',
  '',
];
const USAGES = [
  { input: 1_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 50 },
  { input: 500, cacheRead: 2_000, cacheWrite: 300, cacheWrite1h: 100, output: 75 },
  { input: 0, cacheRead: 0, cacheWrite: 900, cacheWrite1h: 900, output: 0 },
];
// Вводная цена Sonnet 5 кончается 31.08.2026: дата ответа выбирает строку прайса.
const DATES = [Date.parse('2026-08-15T12:00:00Z'), Date.parse('2026-10-01T12:00:00Z')];

describe('деньги звена = деньги ядра (P127)', () => {
  it('P127 hopPriceOf совпадает с priceOf ядра на матрице факт × модель × расход × дата', () => {
    let money = 0;
    for (const route of FACTS)
      for (const model of MODELS)
        for (const usage of USAGES)
          for (const at of DATES) {
            const spec: HopPriceSpec = { route, declared: DECLARED };
            const core = priceOf(route, model, usage, at, { declared: DECLARED });
            const hop = hopPriceOf(spec, model, usage, at);
            const cell = `${JSON.stringify(route)} ${model} ${JSON.stringify(usage)} ${at}`;
            if (core.unit === 'money') {
              money += 1;
              expect(hop, cell).toEqual({ money: core.usd, version: core.version });
            } else {
              const reason = core.unit === 'window' ? 'window' : core.reason;
              expect(hop, cell).toEqual({ money: null, reason });
            }
          }
    // Матрица обязана содержать деньги, иначе сверка была бы сверкой одних пустот.
    expect(money).toBeGreaterThan(20);
  });

  it('P127 свои строки прайса регистрации: та же цена, что у ядра с той же таблицей', () => {
    const entries = [
      {
        id: 'house-model',
        label: 'House',
        price: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
      },
    ];
    const usage = { input: 1_000, cacheRead: 100, cacheWrite: 200, cacheWrite1h: 50, output: 10 };
    const at = Date.parse('2026-10-01T00:00:00Z');
    const core = priceOf(MONEY, 'house-model-v1', usage, at, { entries });
    expect(core.unit).toBe('money');
    expect(hopPriceOf({ route: MONEY, entries }, 'house-model-v1', usage, at)).toEqual({
      money: core.unit === 'money' ? core.usd : NaN,
      version: 'house-model',
    });
    // Своя таблица заменяет встроенную целиком: модели прайса Anthropic в ней нет — денег нет.
    expect(hopPriceOf({ route: MONEY, entries }, 'claude-sonnet-4-5', usage, at)).toEqual({
      money: null,
      reason: 'unknown-price',
    });
  });

  it('P127 регистрация без цены → деньги null с причиной no-price-fact, не число', () => {
    const usage = { input: 1_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 10 };
    expect(hopPriceOf(null, 'claude-sonnet-4-5', usage, Date.now())).toEqual({
      money: null,
      reason: 'no-price-fact',
    });
  });
});
