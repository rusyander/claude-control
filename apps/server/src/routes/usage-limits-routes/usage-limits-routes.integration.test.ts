import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createUsageLimits } from '../../domains/usage-limits/usage-limits.ts';
import { registerUsageLimitsRoutes } from './usage-limits-routes.ts';

/** Маршрут поверх настоящего монитора; подменены сеть и доступ CLI. */
describe('GET /api/usage-limits', () => {
  it('окна с ETag; тот же снимок по If-None-Match — 304 без тела; закрытие гасит таймер', async () => {
    let fetches = 0;
    const limits = createUsageLimits({
      credentials: () => ({
        source: 'file',
        content: JSON.stringify({
          claudeAiOauth: { accessToken: 'секрет', expiresAt: Date.now() + 3_600_000 },
        }),
      }),
      appDataDir: () => 'не-используется',
      listeners: () => 0,
      changed: () => undefined,
      fetch: (async () => {
        fetches += 1;
        return Response.json({ five_hour: { utilization: 42.137, resets_at: null } });
      }) as typeof fetch,
    });
    const app = Fastify();
    registerUsageLimitsRoutes(app, limits);
    try {
      const first = await app.inject({ method: 'GET', url: '/api/usage-limits' });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        status: 'ok',
        source: 'oauth',
        windows: [{ id: 'session', percent: 42.137, resetsAt: null }],
      });
      expect(first.body).not.toContain('секрет');
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();
      const again = await app.inject({
        method: 'GET',
        url: '/api/usage-limits',
        headers: { 'if-none-match': etag },
      });
      expect(again.statusCode).toBe(304);
      expect(again.body).toBe('');
      expect(fetches).toBe(1);
    } finally {
      await app.close();
    }
  });
});
