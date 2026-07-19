import { describe, it, expect } from 'vitest';
import {
  getPricing,
  estimateCost,
  findEntry,
  BUILT_IN_ENTRIES,
  type ModelPricing,
  type PricingEntry,
} from './pricing.ts';

/**
 * Тесты тарификации токенов. Здесь речь про деньги (пусть и справочные —
 * «столько стоило бы через API»), поэтому проверяем ТОЧНЫЕ числа по формуле
 * цены, а не «примерно». Функции чистые, временные каталоги не нужны.
 *
 * Цена привязана к КОНКРЕТНОЙ версии модели: Opus 4.1 стоит $15/$75, а Opus 4.8
 * — $5/$25. Раньше таблица знала только семейства, и все opus считались по цене
 * 4.1 — завышение втрое на каждом прогоне. Отсюда акцент тестов на том, что
 * версии не путаются между собой.
 *
 * Встроенные ставки за миллион токенов (снимок прайса на 19.07.2026):
 *   opus 4.8   → input 5,  output 25, cacheRead 0.5, cacheWrite 6.25
 *   opus 4.1   → input 15, output 75, cacheRead 1.5, cacheWrite 18.75
 *   sonnet 5   → input 2,  output 10 (вводная цена по 31.08.2026), дальше 3/15
 *   haiku 4.5  → input 1,  output 5,  cacheRead 0.1, cacheWrite 1.25
 * fallback (модель не из линейки Claude) = стандартные ставки sonnet 3/15.
 */

/** Нулевой набор токенов — заполняем только нужные поля в конкретном тесте. */
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const M = 1_000_000; // «за миллион» — удобно давать ровно миллион и читать ставку как есть.

/**
 * Фиксированный момент для тестов. У части моделей цена меняется по дате
 * (вводная цена Sonnet 5), и без явного момента тесты протухли бы сами собой
 * 1 сентября 2026 года.
 */
const AT = Date.parse('2026-07-19T12:00:00.000Z');
const AFTER_INTRO = Date.parse('2026-09-15T12:00:00.000Z');

describe('findEntry — сопоставление модели со строкой прайса', () => {
  it('точная версия важнее семейства: opus 4.8 и opus 4.1 считаются по-разному', () => {
    expect(findEntry('claude-opus-4-8', BUILT_IN_ENTRIES, AT)?.id).toBe('claude-opus-4-8');
    expect(findEntry('claude-opus-4-1-20250805', BUILT_IN_ENTRIES, AT)?.id).toBe('claude-opus-4-1');
  });

  it('более длинный идентификатор побеждает: opus 4.8 не уходит в цену opus 4', () => {
    // `claude-opus-4` — подстрока `claude-opus-4-8`. При обходе в произвольном
    // порядке Opus 4.8 посчитался бы по цене Opus 4, то есть втрое дороже.
    const entry = findEntry('claude-opus-4-8', BUILT_IN_ENTRIES, AT);
    expect(entry?.id).toBe('claude-opus-4-8');
    expect(entry?.price.input).toBe(5);
  });

  it('суффикс окна контекста и дата в имени не мешают', () => {
    expect(findEntry('claude-opus-4-8[1m]', BUILT_IN_ENTRIES, AT)?.id).toBe('claude-opus-4-8');
    expect(findEntry('claude-haiku-4-5-20251001', BUILT_IN_ENTRIES, AT)?.id).toBe(
      'claude-haiku-4-5',
    );
  });

  it('старое написание имени (версия перед семейством) тоже находится', () => {
    // До Claude 4 модели назывались `claude-3-5-haiku-…`, а в прайсе строка
    // зовётся `claude-haiku-3-5`. Без этой пары транскрипты тех лет считались
    // бы по цене актуальной модели семейства.
    expect(findEntry('claude-3-5-haiku-20241022', BUILT_IN_ENTRIES, AT)?.id).toBe(
      'claude-haiku-3-5',
    );
  });

  it('незнакомая версия откатывается на самую свежую модель семейства', () => {
    const entry = findEntry('claude-opus-9-9-20990101', BUILT_IN_ENTRIES, AT);
    expect(entry?.id).toBe('claude-opus-4-8');
  });

  it('модель не из линейки Claude не находится вовсе', () => {
    expect(findEntry('gpt-4o', BUILT_IN_ENTRIES, AT)).toBeUndefined();
    expect(findEntry('', BUILT_IN_ENTRIES, AT)).toBeUndefined();
  });

  describe('цены со сроком действия', () => {
    it('до конца срока действует вводная цена Sonnet 5 ($2/$10)', () => {
      const entry = findEntry('claude-sonnet-5', BUILT_IN_ENTRIES, AT);
      expect(entry?.price).toEqual<ModelPricing>({
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      });
    });

    it('после срока — обычная цена ($3/$15)', () => {
      const entry = findEntry('claude-sonnet-5', BUILT_IN_ENTRIES, AFTER_INTRO);
      expect(entry?.price).toEqual<ModelPricing>({
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      });
    });

    it('последний день срока ещё считается вводным', () => {
      const lastDay = Date.parse('2026-08-31T23:00:00.000Z');
      expect(findEntry('claude-sonnet-5', BUILT_IN_ENTRIES, lastDay)?.price.input).toBe(2);
    });
  });
});

describe('getPricing', () => {
  it('берёт цену актуальной модели, когда указано только семейство', () => {
    expect(getPricing('opus', { at: AT })).toEqual<ModelPricing>({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it('регистр имени не важен — сравнение идёт в нижнем регистре', () => {
    expect(getPricing('CLAUDE-OPUS-4-8', { at: AT })).toEqual(
      getPricing('claude-opus-4-8', { at: AT }),
    );
    expect(getPricing('Sonnet', { at: AT })).toEqual(getPricing('sonnet', { at: AT }));
  });

  it('неизвестная модель откатывается на fallback (стандартные ставки sonnet)', () => {
    expect(getPricing('gpt-4o', { at: AT })).toEqual<ModelPricing>({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it('пустая строка модели тоже уходит в fallback без ошибки', () => {
    expect(() => getPricing('')).not.toThrow();
    expect(getPricing('', { at: AT })).toEqual(getPricing('gpt-4o', { at: AT }));
  });

  describe('свои цены из настроек', () => {
    const own: ModelPricing = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

    it('перебивают прайс', () => {
      expect(getPricing('claude-opus-4-8', { overrides: { opus: own }, at: AT })).toEqual(own);
    });

    it('не задевают модели, под чей фрагмент не подходят', () => {
      expect(getPricing('claude-haiku-4-5', { overrides: { opus: own }, at: AT }).input).toBe(1);
      expect(getPricing('claude-haiku-4-5', { overrides: { opus: own }, at: AT })).not.toEqual(own);
    });
  });

  describe('подставленный прайс', () => {
    const entries: PricingEntry[] = [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        price: { input: 99, output: 199, cacheRead: 9, cacheWrite: 19 },
      },
    ];

    it('используется вместо встроенной таблицы', () => {
      expect(getPricing('claude-opus-4-8', { entries, at: AT }).input).toBe(99);
    });

    it('пустой прайс не роняет расчёт — работает fallback', () => {
      expect(getPricing('claude-opus-4-8', { entries: [], at: AT }).input).toBe(3);
    });
  });
});

describe('estimateCost', () => {
  describe('одиночные категории токенов — точная ставка за миллион', () => {
    it('opus 4.8 input: миллион токенов = ставка input (5)', () => {
      expect(estimateCost('claude-opus-4-8', { ...NO_TOKENS, input: M }, { at: AT })).toBe(5);
    });

    it('opus 4.8 output: миллион токенов = ставка output (25)', () => {
      expect(estimateCost('claude-opus-4-8', { ...NO_TOKENS, output: M }, { at: AT })).toBe(25);
    });

    it('opus 4.8 cache read: миллион = ставка cacheRead (0.5)', () => {
      expect(estimateCost('claude-opus-4-8', { ...NO_TOKENS, cacheRead: M }, { at: AT })).toBe(0.5);
    });

    it('opus 4.8 cache write (creation): миллион = ставка cacheWrite (6.25)', () => {
      expect(estimateCost('claude-opus-4-8', { ...NO_TOKENS, cacheCreation: M }, { at: AT })).toBe(
        6.25,
      );
    });

    it('haiku 4.5 output = ставка output (5)', () => {
      expect(estimateCost('claude-haiku-4-5', { ...NO_TOKENS, output: M }, { at: AT })).toBe(5);
    });
  });

  describe('чтение и запись кэша тарифицируются РАЗНЫМИ ставками', () => {
    it('cacheRead и cacheCreation при равном объёме дают разную стоимость', () => {
      const readCost = estimateCost('claude-opus-4-8', { ...NO_TOKENS, cacheRead: M }, { at: AT });
      const writeCost = estimateCost(
        'claude-opus-4-8',
        { ...NO_TOKENS, cacheCreation: M },
        { at: AT },
      );
      // Запись в кэш дороже чтения (6.25 против 0.5) — поля не перепутаны.
      expect(readCost).toBe(0.5);
      expect(writeCost).toBe(6.25);
      expect(writeCost).toBeGreaterThan(readCost);
    });
  });

  describe('точная сумма по всем категориям', () => {
    it('opus 4.8 по миллиону в каждой категории = 36.75', () => {
      const cost = estimateCost(
        'claude-opus-4-8',
        { input: M, output: M, cacheRead: M, cacheCreation: M },
        { at: AT },
      );
      // 5 + 25 + 0.5 + 6.25 = 36.75
      expect(cost).toBe(36.75);
    });
  });

  describe('масштабирование объёма линейно', () => {
    it('половина миллиона input opus 4.8 = половина ставки (2.5)', () => {
      expect(estimateCost('claude-opus-4-8', { ...NO_TOKENS, input: M / 2 }, { at: AT })).toBe(2.5);
    });

    it('удвоение токенов удваивает стоимость', () => {
      const single = estimateCost('claude-opus-4-8', { ...NO_TOKENS, input: M }, { at: AT });
      const double = estimateCost('claude-opus-4-8', { ...NO_TOKENS, input: 2 * M }, { at: AT });
      expect(double).toBe(single * 2);
      expect(double).toBe(10);
    });
  });

  describe('момент расчёта', () => {
    it('исторический расход считается по цене, действовавшей тогда', () => {
      const tokens = { ...NO_TOKENS, output: M };
      // Вводная цена Sonnet 5 — $10 за миллион вывода, после 31.08.2026 — $15.
      expect(estimateCost('claude-sonnet-5', tokens, { at: AT })).toBe(10);
      expect(estimateCost('claude-sonnet-5', tokens, { at: AFTER_INTRO })).toBe(15);
    });
  });

  describe('граничные случаи', () => {
    it('нулевые токены = нулевая стоимость для любой модели', () => {
      expect(estimateCost('claude-opus-4-8', NO_TOKENS, { at: AT })).toBe(0);
      expect(estimateCost('claude-sonnet-5', NO_TOKENS, { at: AT })).toBe(0);
      expect(estimateCost('claude-haiku-4-5', NO_TOKENS, { at: AT })).toBe(0);
      expect(estimateCost('неизвестно', NO_TOKENS, { at: AT })).toBe(0);
    });

    it('неизвестная модель считается по fallback-ставкам, не падает', () => {
      const call = (): number => estimateCost('gpt-4o', { ...NO_TOKENS, input: M }, { at: AT });
      expect(call).not.toThrow();
      expect(call()).toBe(3);
    });
  });

  describe('суммирование/группировка по дням, моделям и проектам', () => {
    // В pricing.ts нет отдельной функции агрегации — реальные отчёты просто
    // складывают per-запись estimateCost. Проверяем именно это свойство:
    // стоимость аддитивна, поэтому группировать можно любым ключом.

    it('стоимость аддитивна: сумма по категориям = стоимость их вместе', () => {
      const byParts =
        estimateCost('claude-opus-4-8', { ...NO_TOKENS, input: M }, { at: AT }) +
        estimateCost('claude-opus-4-8', { ...NO_TOKENS, output: M }, { at: AT }) +
        estimateCost('claude-opus-4-8', { ...NO_TOKENS, cacheRead: M }, { at: AT });
      const together = estimateCost(
        'claude-opus-4-8',
        { input: M, output: M, cacheRead: M, cacheCreation: 0 },
        { at: AT },
      );
      // 5 + 25 + 0.5 = 30.5
      expect(byParts).toBe(30.5);
      expect(together).toBe(30.5);
    });

    it('группировка по дням и моделям даёт точные подытоги и общий итог', () => {
      // Модель отчёта: строки использования с датой, моделью и токенами.
      const usage = [
        { day: '2026-07-18', model: 'claude-opus-4-8', tokens: { ...NO_TOKENS, input: M } }, // 5
        { day: '2026-07-18', model: 'claude-sonnet-5', tokens: { ...NO_TOKENS, output: M } }, // 10
        { day: '2026-07-19', model: 'claude-haiku-4-5', tokens: { ...NO_TOKENS, output: M } }, // 5
      ];

      const perDay = usage.reduce<Record<string, number>>((acc, row) => {
        acc[row.day] = (acc[row.day] ?? 0) + estimateCost(row.model, row.tokens, { at: AT });
        return acc;
      }, {});

      expect(perDay['2026-07-18']).toBe(15); // opus 5 + sonnet 10
      expect(perDay['2026-07-19']).toBe(5); // haiku 5

      const grandTotal = usage.reduce(
        (sum, row) => sum + estimateCost(row.model, row.tokens, { at: AT }),
        0,
      );
      expect(grandTotal).toBe(20); // 15 + 5
    });

    it('итог по проекту = сумма стоимостей его моделей', () => {
      // «Проект» — это просто ещё один ключ группировки поверх той же аддитивности.
      const projectRows = [
        { model: 'claude-opus-4-8', tokens: { ...NO_TOKENS, input: M } }, // 5
        { model: 'claude-opus-4-8', tokens: { ...NO_TOKENS, cacheCreation: M } }, // 6.25
        { model: 'claude-haiku-4-5', tokens: { ...NO_TOKENS, output: M } }, // 5
      ];
      const projectTotal = projectRows.reduce(
        (sum, r) => sum + estimateCost(r.model, r.tokens, { at: AT }),
        0,
      );
      // 5 + 6.25 + 5 = 16.25
      expect(projectTotal).toBe(16.25);
    });
  });
});
