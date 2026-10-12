import { describe, expect, it } from 'vitest';
import type { ApiEndpoint } from '@entities/ApiExplorer';
import { draftFromEndpoint, row } from './apiRequest';
import { fillWithSample, sampleFromSchema, type Random } from './apiSample';

/** Повторяемая случайность: линейный конгруэнтный генератор от зерна. */
const seeded = (seed: number): Random => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

const ORDER = {
  type: 'object',
  required: ['email', 'qty'],
  properties: {
    id: { type: 'string', format: 'uuid', readOnly: true },
    email: { type: 'string', format: 'email' },
    qty: { type: 'integer', minimum: 2, maximum: 5 },
    price: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
    status: { type: 'string', enum: ['new', 'paid'] },
    createdAt: { type: 'string', format: 'date-time' },
    code: { type: 'string', minLength: 12, maxLength: 12 },
    tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
    owner: { $circular: 'User' },
    gift: { type: ['boolean', 'null'] },
  },
};

describe('sampleFromSchema', () => {
  it('форма и пределы схемы соблюдены на сотне зёрен', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const sample = sampleFromSchema(ORDER, seeded(seed)) as Record<string, unknown>;
      expect(sample.id).toBeUndefined();
      expect(sample.owner).toBeUndefined();
      expect(sample.email).toMatch(/^[a-z]+\.\d+@example\.com$/);
      expect(sample.qty).toBeGreaterThanOrEqual(2);
      expect(sample.qty).toBeLessThanOrEqual(5);
      expect(Number.isInteger(sample.qty)).toBe(true);
      expect(sample.price).toBeGreaterThan(0);
      expect(sample.price).toBeLessThanOrEqual(10);
      expect(['new', 'paid']).toContain(sample.status);
      expect(sample.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(String(sample.code)).toHaveLength(12);
      expect((sample.tags as string[]).length).toBeGreaterThanOrEqual(1);
      expect((sample.tags as string[]).length).toBeLessThanOrEqual(3);
      expect(typeof sample.gift).toBe('boolean');
    }
  });

  it('uuid по формату и по имени поля; allOf сливается, oneOf — один вариант', () => {
    const random = seeded(7);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(sampleFromSchema({ type: 'string', format: 'uuid' }, random)).toMatch(uuid);
    expect(sampleFromSchema({ type: 'string' }, random, 'user_id')).toMatch(uuid);
    expect(
      sampleFromSchema(
        {
          allOf: [
            { type: 'object', properties: { a: { const: 1 } } },
            { properties: { b: { const: 2 } } },
          ],
        },
        random,
      ),
    ).toEqual({ a: 1, b: 2 });
    expect([1, 2]).toContain(sampleFromSchema({ oneOf: [{ const: 1 }, { const: 2 }] }, random));
  });

  it('разные нажатия — разные значения', () => {
    const a = JSON.stringify(sampleFromSchema(ORDER, seeded(1)));
    const b = JSON.stringify(sampleFromSchema(ORDER, seeded(2)));
    expect(a).not.toBe(b);
  });
});

describe('fillWithSample', () => {
  const endpoint: ApiEndpoint = {
    id: 'POST /orders/{id}',
    method: 'post',
    path: '/orders/{id}',
    tags: [],
    params: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      { name: 'dry', in: 'query', required: false, schema: { type: 'boolean' } },
      { name: 'lang', in: 'query', required: true, schema: { enum: ['ru', 'en'] } },
    ],
    body: { contentType: 'application/json', required: true, schema: ORDER },
    responses: [],
  };

  it('путь, запрос и тело заполнены; включённость строк и свои строки не тронуты', () => {
    const base = draftFromEndpoint(endpoint);
    base.query.push(row('mine', 'keep'));
    const { draft, filled } = fillWithSample(base, endpoint, seeded(3));
    expect(filled).toBe(4);
    expect(Number(draft.pathValues.id)).toBeGreaterThanOrEqual(1);
    const dry = draft.query.find((item) => item.name === 'dry');
    expect(['true', 'false']).toContain(dry?.value);
    expect(dry?.enabled).toBe(false);
    expect(draft.query.find((item) => item.name === 'lang')?.enabled).toBe(true);
    expect(draft.query.find((item) => item.name === 'mine')?.value).toBe('keep');
    expect(Object.keys(JSON.parse(draft.body) as object)).toContain('email');
  });

  it('тело не JSON — не трогается', () => {
    const form = { ...endpoint, params: [], body: { contentType: 'text/plain', required: true } };
    const base = { ...draftFromEndpoint(form), body: 'как было' };
    expect(fillWithSample(base, form, seeded(1))).toEqual({ draft: base, filled: 0 });
  });
});
