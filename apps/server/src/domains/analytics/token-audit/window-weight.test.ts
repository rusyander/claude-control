import { describe, it, expect } from 'vitest';
import { modelFactor, roundWeight, windowWeight } from './window-weight.ts';

const tokens = {
  input: 1000,
  cacheRead: 100_000,
  cacheWrite: 30_000,
  cacheWrite1h: 10_000,
  output: 2000,
};

describe('window-weight — вес вызова в окне подписки', () => {
  it('множитель модели: Opus 5, Sonnet 3, Haiku 1; неизвестная — как Opus', () => {
    expect(modelFactor('claude-opus-5-5')).toBe(5);
    expect(modelFactor('claude-sonnet-5')).toBe(3);
    expect(modelFactor('claude-haiku-4-5')).toBe(1);
    expect(modelFactor(undefined)).toBe(5);
  });

  it('множитель по версии: Opus 4/4.1 — 15, Opus 4.5+ — 5, Haiku 3.5 — 0,8', () => {
    expect(modelFactor('claude-opus-4-20250514')).toBe(15);
    expect(modelFactor('claude-opus-4-1-20250805')).toBe(15);
    expect(modelFactor('claude-opus-4-1')).toBe(15);
    expect(modelFactor('claude-opus-4-5-20251101')).toBe(5);
    expect(modelFactor('claude-opus-4-8')).toBe(5);
    expect(modelFactor('claude-haiku-3-5-20241022')).toBe(0.8);
    // Имя до Claude 4: версия перед семейством — по своей цене, а не как Opus 4.8.
    expect(modelFactor('claude-3-opus-20240229')).toBe(15);
    expect(modelFactor('gpt-5')).toBe(5);
  });

  it('запись 5 мин = вся запись минус часовая; чтение кеша — десятая часть', () => {
    // 1000 + 1,25·20000 + 2·10000 + 0,1·100000 + 5·2000 = 66 000 → ×3 / 1e6
    expect(windowWeight(tokens, 'claude-sonnet-5')).toBeCloseTo(0.198, 9);
    expect(windowWeight(tokens, 'claude-opus-5-5')).toBeCloseTo(0.33, 9);
  });

  it('часовая запись больше всей (битая строка) не даёт отрицательной записи 5 мин', () => {
    expect(windowWeight({ ...tokens, cacheWrite1h: 50_000 }, 'haiku')).toBeCloseTo(
      (1000 + 2 * 30_000 + 10_000 + 10_000) / 1e6,
      9,
    );
  });

  it('отрицательная часовая запись (битая строка) не даёт записи 5 мин больше всей записи', () => {
    expect(windowWeight({ ...tokens, cacheWrite1h: -10_000 }, 'haiku')).toBeCloseTo(
      (1000 + 1.25 * 30_000 + 10_000 + 10_000) / 1e6,
      9,
    );
  });

  it('округление до сотых', () => {
    expect(roundWeight(1.23456)).toBe(1.23);
  });
});
