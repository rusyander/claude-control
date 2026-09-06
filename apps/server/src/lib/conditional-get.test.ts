/**
 * Условный GET сторожит транспорт списка разговоров: панель спрашивает его на
 * каждое событие наблюдателя, и без 304 каждый ответ — 70–80 КБ. Тесты держат
 * контракт с браузером: слабый ETag и no-cache на первом ответе, 304 без тела
 * на совпавший If-None-Match, полный ответ при смене данных или чужом
 * валидаторе; сравнение заголовка — по содержимому, а не по байтам.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { etagOf, matchesIfNoneMatch, sendConditional } from './conditional-get.ts';

describe('условный GET: ETag и 304', () => {
  let app: FastifyInstance;
  let payload: unknown;

  beforeEach(async () => {
    payload = [{ id: 'a', title: 'первый' }];
    app = Fastify();
    app.get('/list', (request, reply) => sendConditional(request, reply, payload));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('первый ответ — 200 с JSON, слабым ETag и no-cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/list' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toMatch(/^W\/".+"$/);
    expect(res.json()).toEqual(payload);
  });

  it('повтор с тем же If-None-Match — 304 без тела, ETag на месте', async () => {
    const first = await app.inject({ method: 'GET', url: '/list' });
    const second = await app.inject({
      method: 'GET',
      url: '/list',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('данные изменились — снова 200 и другой ETag', async () => {
    const first = await app.inject({ method: 'GET', url: '/list' });
    payload = [
      { id: 'a', title: 'первый' },
      { id: 'b', title: 'второй' },
    ];
    const second = await app.inject({
      method: 'GET',
      url: '/list',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.json()).toEqual(payload);
  });

  it('чужой или пустой валидатор — полный ответ', async () => {
    const stale = await app.inject({
      method: 'GET',
      url: '/list',
      headers: { 'if-none-match': 'W/"nope"' },
    });
    expect(stale.statusCode).toBe(200);
    const bare = await app.inject({ method: 'GET', url: '/list' });
    expect(bare.statusCode).toBe(200);
  });
});

describe('сравнение If-None-Match', () => {
  const etag = etagOf('{"a":1}');

  it('совпадение: точное, сильная форма, список через запятую, звёздочка', () => {
    expect(matchesIfNoneMatch(etag, etag)).toBe(true);
    expect(matchesIfNoneMatch(etag.replace(/^W\//, ''), etag)).toBe(true);
    expect(matchesIfNoneMatch(`W/"other", ${etag}`, etag)).toBe(true);
    expect(matchesIfNoneMatch(['W/"other"', etag], etag)).toBe(true);
    expect(matchesIfNoneMatch('*', etag)).toBe(true);
  });

  it('несовпадение: другой хэш, пустой заголовок', () => {
    expect(matchesIfNoneMatch('W/"other"', etag)).toBe(false);
    expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
    expect(matchesIfNoneMatch('', etag)).toBe(false);
  });

  it('один и тот же текст — один и тот же ETag, разный — разный', () => {
    expect(etagOf('x')).toBe(etagOf('x'));
    expect(etagOf('x')).not.toBe(etagOf('y'));
  });
});
