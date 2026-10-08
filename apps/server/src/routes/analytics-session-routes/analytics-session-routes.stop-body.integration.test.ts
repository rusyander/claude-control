import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAnalyticsSessionRoutes } from './analytics-session-routes.ts';

/**
 * Ревью 28.09 (F-361): `startedAt`, который не дата, проходил схему и получал
 * ответ «номер занят другим процессом» — неверная причина для кривого запроса.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /api/analytics/sessions/:id/stop — тело', () => {
  it('startedAt не дата → 400, а не «номер занят»', async () => {
    app = Fastify();
    registerAnalyticsSessionRoutes(
      app,
      { location: { paths: { root: '/nonexistent-agentdeck-test' } } } as never,
      { active: () => [] },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/analytics/sessions/00000000-0000-0000-0000-000000000000/stop',
      payload: { pid: 999_999_999, startedAt: 'не дата' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
  });
});
