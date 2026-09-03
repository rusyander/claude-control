import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAccessGate } from './access-gate.ts';
import { allowedOrigins } from './origin-guard.ts';

/**
 * Гейт доступа тем же хуком, что стоит у человека, на своём Fastify.
 *
 * Главное здесь — токен строкой запроса: он принимается ТОЛЬКО на потоке
 * событий (`EventSource` не умеет заголовков), а на любом другом маршруте
 * запрос с `?token=` отклоняется как запрос без токена. Раньше `?token=`
 * проходил везде, и токен оседал в журналах прокси и истории браузера.
 */
describe('access-gate: токен строкой запроса принимает только поток событий', () => {
  const TOKEN = 'S3cr3t-token-value';
  const bearer = { authorization: `Bearer ${TOKEN}` };
  let app: FastifyInstance;
  let enabled: boolean;

  beforeEach(async () => {
    enabled = true;
    app = Fastify();
    registerAccessGate(app, {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => enabled,
      expectedToken: () => TOKEN,
    });
    // Маршруты-заглушки: гейт стоит ДО них, поэтому 200 означает «пропущен».
    app.get('/api/system', () => ({ ok: true }));
    app.get('/api/events', () => ({ stream: true }));
    app.get('/api/chat/:id/stream', () => ({ stream: true }));
    app.post('/api/projects', () => ({ created: true }));
    app.get('/api/mcp/oauth/callback', () => ({ oauth: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('Bearer проходит везде', async () => {
    expect((await app.inject({ url: '/api/system', headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/events', headers: bearer })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/projects', headers: bearer, payload: {} }))
        .statusCode,
    ).toBe(200);
  });

  it('?token= на обычном маршруте — 401, как и вовсе без токена', async () => {
    const plain = await app.inject({ url: '/api/system', query: { token: TOKEN } });
    expect(plain.statusCode).toBe(401);
    expect(plain.json()).toEqual({ error: 'Нужен токен доступа' });

    const mutating = await app.inject({
      method: 'POST',
      url: '/api/projects',
      query: { token: TOKEN },
      payload: {},
    });
    expect(mutating.statusCode).toBe(401);
  });

  it('?token= на потоке чата — 401: его читают fetch-ом с заголовком', async () => {
    const stream = await app.inject({ url: '/api/chat/abc/stream', query: { token: TOKEN } });
    expect(stream.statusCode).toBe(401);
  });

  it('?token= на /api/events — 200; чужой — 401', async () => {
    expect((await app.inject({ url: '/api/events', query: { token: TOKEN } })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: '/api/events', query: { token: 'nope' } })).statusCode).toBe(
      401,
    );
  });

  it('заголовок сильнее строки запроса и на потоке: неверный Bearer не спасается верным ?token=', async () => {
    const response = await app.inject({
      url: '/api/events',
      query: { token: TOKEN },
      headers: { authorization: 'Bearer nope' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('без токена — 401 везде при включённом доступе', async () => {
    expect((await app.inject({ url: '/api/system' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/events' })).statusCode).toBe(401);
  });

  it('выключенный удалённый доступ — токен не спрашивается', async () => {
    enabled = false;
    expect((await app.inject({ url: '/api/system' })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/system', query: { token: 'anything' } })).statusCode,
    ).toBe(200);
  });

  it('чужой Origin — 403 даже с правильным токеном', async () => {
    const response = await app.inject({
      url: '/api/system',
      headers: { ...bearer, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('возврат OAuth проходит без токена: вход защищён параметром state', async () => {
    const response = await app.inject({
      url: '/api/mcp/oauth/callback',
      query: { code: 'x', state: 'y' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(200);
  });
});
