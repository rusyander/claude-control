import { describe, it, expect } from 'vitest';
import { GatewayJournal } from './usage.ts';

/**
 * Учёт расхода шлюза: ТОЛЬКО ТОКЕНЫ.
 *
 * Денег здесь нет и быть не должно. Раньше журнал считал «ту же формулу, что у
 * контура» — токены × 0.00001 $; такой формулы у контура нет (он тарифицирует по
 * ценам реестра моделей), и цифра выдавала наше число за чужое. Деньги —
 * единственные, оценка по нашему прайсу — живут в `spend.ts`.
 */

describe('журнал шлюза', () => {
  it('расход копится по контурам отдельно', () => {
    const journal = new GatewayJournal();
    journal.addUsage('a', { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    journal.addUsage('a', { promptTokens: 5, completionTokens: 1, totalTokens: 6 });
    journal.addUsage('b', { promptTokens: 1, completionTokens: 1, totalTokens: 2 });

    const usage = journal.usage();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      platformId: 'a',
      requests: 2,
      promptTokens: 15,
      totalTokens: 18,
    });
    // Денежного поля в записи нет вовсе: «внутренняя единица контура» была
    // выдуманной, и вернуться она может только вместе с этим ключом.
    expect(usage[0]).not.toHaveProperty('unitUsd');
  });

  it('запрос без расхода всё равно считается запросом', () => {
    const journal = new GatewayJournal();
    journal.addUsage('a', { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(journal.usage()[0]).toMatchObject({ requests: 1, totalTokens: 0 });
  });

  it('следы идут новыми сверху и не растут бесконечно', () => {
    const journal = new GatewayJournal();
    for (let i = 0; i < 60; i += 1) {
      journal.addEvent({
        at: new Date().toISOString(),
        platformId: 'a',
        path: `/a/v1/chat/completions?${i}`,
        dialect: 'openai-compat',
        status: 200,
        stages: [],
        summarized: false,
        violations: [],
        masked: false,
        blocked: false,
        interrupted: false,
        unknownFrames: [],
        lost: [],
        totalTokens: 0,
      });
    }
    const events = journal.events();
    expect(events).toHaveLength(50);
    expect(events[0]?.path).toContain('?59');
    // Счётчик считает ВСЕ, а не последние пятьдесят.
    expect(journal.totals().requests).toBe(60);
  });

  it('отказ отличается от удачи в счётчиках', () => {
    const journal = new GatewayJournal();
    const base = {
      at: new Date().toISOString(),
      platformId: 'a',
      path: '/a/v1/messages',
      dialect: 'anthropic',
      stages: [],
      summarized: false,
      violations: [],
      masked: false,
      blocked: false,
      interrupted: false,
      unknownFrames: [],
      lost: [],
      totalTokens: 0,
    };
    journal.addEvent({ ...base, status: 200 });
    journal.addEvent({ ...base, status: 502 });
    expect(journal.totals()).toEqual({ requests: 2, failures: 1 });

    journal.clear();
    expect(journal.totals()).toEqual({ requests: 0, failures: 0 });
    expect(journal.events()).toEqual([]);
  });
});
