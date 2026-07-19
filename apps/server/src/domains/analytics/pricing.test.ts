import { describe, it, expect } from 'vitest';
import { getPricing, estimateCost, type ModelPricing } from './pricing.ts';

/**
 * Тесты тарификации токенов. Здесь речь про деньги (пусть и справочные —
 * «столько стоило бы через API»), поэтому проверяем ТОЧНЫЕ числа по формуле
 * цены, а не «примерно». Функции чистые, временные каталоги не нужны.
 *
 * Ставки за миллион токенов зашиты в pricing.ts:
 *   opus   → input 15,  output 75, cacheRead 1.5,  cacheWrite 18.75
 *   sonnet → input 3,   output 15, cacheRead 0.3,  cacheWrite 3.75
 *   haiku  → input 0.8, output 4,  cacheRead 0.08, cacheWrite 1
 * fallback (неизвестная модель) = ставки sonnet.
 */

/** Нулевой набор токенов — заполняем только нужные поля в конкретном тесте. */
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const M = 1_000_000; // «за миллион» — удобно давать ровно миллион и читать ставку как есть.

describe('getPricing', () => {
  it('подбирает тариф opus по вхождению фрагмента в имя модели', () => {
    // Реальные имена моделей содержат суффикс-дату — ищем по подстроке.
    expect(getPricing('claude-opus-4-1-20250805')).toEqual<ModelPricing>({
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75,
    });
  });

  it('подбирает тариф sonnet', () => {
    expect(getPricing('claude-3-5-sonnet-20241022')).toEqual<ModelPricing>({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it('подбирает тариф haiku', () => {
    expect(getPricing('claude-3-5-haiku-20241022')).toEqual<ModelPricing>({
      input: 0.8,
      output: 4,
      cacheRead: 0.08,
      cacheWrite: 1,
    });
  });

  it('регистр имени не важен — сравнение идёт в нижнем регистре', () => {
    expect(getPricing('CLAUDE-OPUS-4')).toEqual(getPricing('claude-opus-4'));
    expect(getPricing('Sonnet')).toEqual(getPricing('sonnet'));
  });

  it('поиск по подстроке переживает смену суффикса модели', () => {
    // Другой год/ревизия в конце имени не должны сбивать подбор тарифа.
    expect(getPricing('claude-opus-4-5-99999999')).toEqual(getPricing('opus'));
  });

  it('неизвестная модель откатывается на fallback (ставки sonnet), не падает', () => {
    const fallback = getPricing('gpt-4o');
    expect(fallback).toEqual<ModelPricing>({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    // Fallback по значениям совпадает с тарифом sonnet.
    expect(fallback).toEqual(getPricing('sonnet'));
  });

  it('пустая строка модели тоже уходит в fallback без ошибки', () => {
    expect(() => getPricing('')).not.toThrow();
    expect(getPricing('')).toEqual(getPricing('sonnet'));
  });
});

describe('estimateCost', () => {
  describe('одиночные категории токенов — точная ставка за миллион', () => {
    it('opus input: миллион токенов = ставка input (15)', () => {
      expect(estimateCost('opus', { ...NO_TOKENS, input: M })).toBe(15);
    });

    it('opus output: миллион токенов = ставка output (75)', () => {
      expect(estimateCost('opus', { ...NO_TOKENS, output: M })).toBe(75);
    });

    it('opus cache read: миллион = ставка cacheRead (1.5)', () => {
      expect(estimateCost('opus', { ...NO_TOKENS, cacheRead: M })).toBe(1.5);
    });

    it('opus cache write (creation): миллион = ставка cacheWrite (18.75)', () => {
      expect(estimateCost('opus', { ...NO_TOKENS, cacheCreation: M })).toBe(18.75);
    });

    it('sonnet input и output считаются по своим ставкам (3 и 15)', () => {
      expect(estimateCost('sonnet', { ...NO_TOKENS, input: M })).toBe(3);
      expect(estimateCost('sonnet', { ...NO_TOKENS, output: M })).toBe(15);
    });

    it('haiku output = ставка output (4)', () => {
      expect(estimateCost('haiku', { ...NO_TOKENS, output: M })).toBe(4);
    });
  });

  describe('чтение и запись кэша тарифицируются РАЗНЫМИ ставками', () => {
    it('cacheRead и cacheCreation при равном объёме дают разную стоимость', () => {
      const sameVolume = M;
      const readCost = estimateCost('opus', { ...NO_TOKENS, cacheRead: sameVolume });
      const writeCost = estimateCost('opus', { ...NO_TOKENS, cacheCreation: sameVolume });
      // Запись в кэш дороже чтения (18.75 против 1.5) — поля не перепутаны.
      expect(readCost).toBe(1.5);
      expect(writeCost).toBe(18.75);
      expect(writeCost).toBeGreaterThan(readCost);
    });
  });

  describe('точная сумма по всем категориям', () => {
    it('opus по миллиону в каждой категории = 110.25', () => {
      const cost = estimateCost('opus', {
        input: M,
        output: M,
        cacheRead: M,
        cacheCreation: M,
      });
      // 15 + 75 + 1.5 + 18.75 = 110.25
      expect(cost).toBe(110.25);
    });
  });

  describe('масштабирование объёма линейно', () => {
    it('половина миллиона input opus = половина ставки (7.5)', () => {
      expect(estimateCost('opus', { ...NO_TOKENS, input: M / 2 })).toBe(7.5);
    });

    it('удвоение токенов удваивает стоимость', () => {
      const single = estimateCost('opus', { ...NO_TOKENS, input: M });
      const double = estimateCost('opus', { ...NO_TOKENS, input: 2 * M });
      expect(double).toBe(single * 2);
      expect(double).toBe(30);
    });
  });

  describe('граничные случаи', () => {
    it('нулевые токены = нулевая стоимость для любой модели', () => {
      expect(estimateCost('opus', NO_TOKENS)).toBe(0);
      expect(estimateCost('sonnet', NO_TOKENS)).toBe(0);
      expect(estimateCost('haiku', NO_TOKENS)).toBe(0);
      expect(estimateCost('неизвестно', NO_TOKENS)).toBe(0);
    });

    it('неизвестная модель считается по fallback-ставкам (как sonnet), не падает', () => {
      // input миллион по fallback = 3 (ставка sonnet input).
      expect(() => estimateCost('gpt-4o', { ...NO_TOKENS, input: M })).not.toThrow();
      expect(estimateCost('gpt-4o', { ...NO_TOKENS, input: M })).toBe(3);
      expect(estimateCost('gpt-4o', { ...NO_TOKENS, input: M })).toBe(
        estimateCost('sonnet', { ...NO_TOKENS, input: M }),
      );
    });
  });

  describe('суммирование/группировка по дням, моделям и проектам', () => {
    // В pricing.ts нет отдельной функции агрегации — реальные отчёты просто
    // складывают per-запись estimateCost. Проверяем именно это свойство:
    // стоимость аддитивна, поэтому группировать можно любым ключом.

    it('стоимость аддитивна: сумма по категориям = стоимость их вместе', () => {
      const byParts =
        estimateCost('opus', { ...NO_TOKENS, input: M }) +
        estimateCost('opus', { ...NO_TOKENS, output: M }) +
        estimateCost('opus', { ...NO_TOKENS, cacheRead: M });
      const together = estimateCost('opus', {
        input: M,
        output: M,
        cacheRead: M,
        cacheCreation: 0,
      });
      // 15 + 75 + 1.5 = 91.5
      expect(byParts).toBe(91.5);
      expect(together).toBe(91.5);
      expect(byParts).toBe(together);
    });

    it('группировка по дням и моделям даёт точные подытоги и общий итог', () => {
      // Модель отчёта: строки использования с датой, моделью и токенами.
      const usage = [
        { day: '2026-07-18', model: 'claude-opus-4', tokens: { ...NO_TOKENS, input: M } }, // 15
        { day: '2026-07-18', model: 'claude-sonnet-4', tokens: { ...NO_TOKENS, output: M } }, // 15
        { day: '2026-07-19', model: 'claude-haiku-4', tokens: { ...NO_TOKENS, output: M } }, // 4
      ];

      const perDay = usage.reduce<Record<string, number>>((acc, row) => {
        acc[row.day] = (acc[row.day] ?? 0) + estimateCost(row.model, row.tokens);
        return acc;
      }, {});

      expect(perDay['2026-07-18']).toBe(30); // opus 15 + sonnet 15
      expect(perDay['2026-07-19']).toBe(4); // haiku 4

      const grandTotal = usage.reduce((sum, row) => sum + estimateCost(row.model, row.tokens), 0);
      expect(grandTotal).toBe(34); // 30 + 4
    });

    it('итог по проекту = сумма стоимостей его моделей', () => {
      // «Проект» — это просто ещё один ключ группировки поверх той же аддитивности.
      const projectRows = [
        { model: 'opus', tokens: { ...NO_TOKENS, input: M } }, // 15
        { model: 'opus', tokens: { ...NO_TOKENS, cacheCreation: M } }, // 18.75
        { model: 'haiku', tokens: { ...NO_TOKENS, output: M } }, // 4
      ];
      const projectTotal = projectRows.reduce((sum, r) => sum + estimateCost(r.model, r.tokens), 0);
      // 15 + 18.75 + 4 = 37.75
      expect(projectTotal).toBe(37.75);
    });
  });
});
